import { appendEvent } from "$lib/server/sessions/events";
import { raiseSessionUserEvents } from "$lib/server/sessions/spawn";
import { raiseSessionEvent } from "$lib/server/sessions/control";
import { sessionUsesNativeGoal } from "$lib/server/sessions/runtime-target";
import type { ThreadGoalRow } from "$lib/server/db/schema";
import {
	accrueUsage,
	claimBudgetSteer,
	claimIterationCap,
	claimNextContinuation,
	getCurrentGoal,
	getDrivableGoal,
	getSessionWorkflowExecutionId,
	hasGoalCompletedEvent,
	latestEventMeta,
	pauseGoal,
	rawLatestEventAgeSeconds,
	sessionStopState,
} from "./repo";
import {
	renderBudgetLimitPrompt,
	renderContinuationPrompt,
	type GoalBudgetView,
} from "./render";

/**
 * Goal-loop driver (Codex `/goal` parity, adapted to workflow-builder live
 * sessions). The loop is event-driven off the append-only session_events log
 * (no in-process timer): on each `agent.llm_usage` we accrue the turn's tokens
 * into the goal; on each `session.status_idle{end_turn}` we decide whether to
 * inject the next continuation turn. A continuation is just a `user.message`
 * raised into the live session_workflow, which keeps full conversation history
 * because the interactive session runs as one durable instance.
 *
 * Exactly-once is guaranteed by `claimNextContinuation` (atomic iteration
 * bump) + the "latest event is status_idle" gate + the deterministic
 * sourceEventId — so the inline hook and the tick reaper never double-drive.
 */

const TERMINAL_SESSION_STATUSES = new Set([
	"terminated",
	"completed",
	"failed",
	"canceled",
	"cancelled",
]);

/**
 * Lost-idle crash window (tick reaper only): the runtime's session-event
 * ingest is fire-and-forget, so a `session.status_idle` published while the
 * BFF is down never lands — the stored stream stays frozen at mid-turn
 * chatter and the strict idle gate would stall the loop forever. When the
 * latest stored event is at least this old, the reaper probes by posting the
 * continuation anyway: if a turn is genuinely still running, Dapr buffers the
 * raised event until the workflow's next wait_for_external_event, so the
 * probe is safe (and the atomic iteration claim still dedupes).
 */
const LOST_IDLE_GRACE_SECONDS = Number(
	process.env.GOAL_LOOP_LOST_IDLE_GRACE_SECONDS || 180,
);

/**
 * Budget delta for one LLM call — codex semantics (`input - cached_input +
 * output`): cache READS are excluded. Our runtimes report `input_tokens`
 * already net of cache reads (cache_read_input_tokens is a separate field),
 * so the codex-equivalent delta is input + output + cache WRITES (creation
 * tokens are genuinely processed input, billed at a premium). Counting cache
 * reads exhausted budgets ~20x faster than the work justified on
 * agentic loops that run 95%+ cached (observed: a $0.03 turn consuming 300k
 * of "budget").
 */
function tokensFromUsage(data: Record<string, unknown> | undefined): number {
	const n = (key: string): number => {
		const v = Math.round(Number(data?.[key] ?? 0));
		return Number.isFinite(v) && v > 0 ? v : 0;
	};
	return (
		n("input_tokens") +
		n("output_tokens") +
		n("cache_creation_input_tokens")
	);
}

function toBudgetView(goal: ThreadGoalRow): GoalBudgetView {
	return {
		objective: goal.objective,
		tokensUsed: goal.tokensUsed,
		tokenBudget: goal.tokenBudget,
		timeUsedSeconds: goal.timeUsedSeconds,
	};
}

/**
 * Entry point invoked from appendEvent's side-effect block for the event types
 * the loop cares about. Fire-and-forget; never throws into the caller.
 */
export async function onSessionEvent(
	sessionId: string,
	event: { type: string; data?: Record<string, unknown> },
): Promise<void> {
	try {
		if (event.type === "agent.llm_usage") {
			const goal = await getDrivableGoal(sessionId);
			if (!goal) return;
			const delta = tokensFromUsage(event.data);
			if (delta > 0) await accrueUsage(sessionId, delta);
			return;
		}
		if (event.type === "session.status_idle") {
			const reason = (
				event.data?.stop_reason as { type?: string } | undefined
			)?.type;
			// Only an end_turn idle (the agent finished its turn) drives a
			// continuation. Terminal idles (max_iters, etc.) are ignored.
			if (reason && reason !== "end_turn") return;
			// Idle-rescue: if the goal already completed (native-goal CLIs emit
			// session.goal_completed and may then run a post-completion turn that
			// races the cooperative terminate raised on goal_completed), re-fire the
			// terminate on this clean idle boundary so the parent durable/run isn't
			// wedged. Idempotent + gated on a recorded goal_completed so it never
			// fires mid-goal. Custom-loop runtimes reach completion via the
			// emit→goal_completed path, so this only matters for native CLIs.
			if (await hasGoalCompletedEvent(sessionId)) {
				await terminateWorkflowGoalSessionIfNeeded(sessionId);
				return;
			}
			await driveContinuationIfIdle(sessionId);
			return;
		}
		if (event.type === "session.goal_completed") {
			// Workflow-driven goal sessions must end so the parent durable/run
			// resumes; direct (UI) goal sessions stay idle (emit-only). Covers BOTH
			// completion sources (BFF custom loop + native-CLI adapter) since both
			// land here as session.goal_completed.
			await terminateWorkflowGoalSessionIfNeeded(sessionId);
			return;
		}
	} catch (err) {
		console.warn(`[goal-loop] onSessionEvent(${event.type}) failed:`, err);
	}
}

/**
 * Kick the loop outside of an idle event — used by the session goal API after
 * a human sets a goal on an already-idle session, and by the tick reaper
 * backstop (which passes allowStaleIdleProbe to recover the lost-idle crash
 * window). Safe to call repeatedly (the idle gate + atomic claim dedupe).
 */
export async function kickGoalLoop(
	sessionId: string,
	opts: { allowStaleIdleProbe?: boolean; kickoff?: boolean } = {},
): Promise<void> {
	try {
		await driveContinuationIfIdle(sessionId, opts);
	} catch (err) {
		console.warn(`[goal-loop] kickGoalLoop failed:`, err);
	}
}

/**
 * Finalize a workflow-driven session whose goal is already COMPLETE but which
 * hasn't terminated — used by the tick reaper. Covers a custom-loop agent that
 * marked the goal complete via the goal MCP and then DIDN'T idle (its TUI went
 * silent mid-turn), so the idle-gated emit→terminate never fired and the parent
 * durable/run wedged. Both calls are idempotent (emit dedupes on sourceEventId;
 * terminate raise is a no-op on an already-ending session).
 */
export async function finalizeCompletedWorkflowGoal(
	sessionId: string,
): Promise<void> {
	try {
		// Emits session.goal_completed if the goal is complete (→ onSessionEvent
		// fires terminate). The explicit terminate below is the belt-and-suspenders
		// path when the event already exists (appendEvent dedupes, so onSessionEvent
		// would not re-fire).
		await emitGoalCompletedIfDone(sessionId);
		await terminateWorkflowGoalSessionIfNeeded(sessionId);
	} catch (err) {
		console.warn(`[goal-loop] finalizeCompletedWorkflowGoal failed:`, err);
	}
}

/**
 * Uniform completion signal for CUSTOM-loop runtimes (agy + dapr-agent-py):
 * when the agent has marked the goal complete via the goal MCP `update_goal`,
 * emit `session.goal_completed` (idempotent via sourceEventId) so it matches the
 * native CLIs' signal. No-op for native-goal CLIs (claude/codex) — they have no
 * thread_goals row and emit their own signal from the adapter/transcript.
 */
async function emitGoalCompletedIfDone(sessionId: string): Promise<void> {
	const goal = await getCurrentGoal(sessionId);
	if (!goal || goal.status !== "complete") return;
	await appendEvent(sessionId, {
		type: "session.goal_completed",
		data: {
			completionSource: "custom_goal_loop",
			goalStatus: "complete",
			objective: goal.objective,
		},
		processedAt: null,
		sourceEventId: `goal-completed:${sessionId}:${goal.goalId}`,
	});
}

/**
 * When a goal completes (or terminally caps) on a WORKFLOW-driven session, end
 * the session so the parent durable/run resumes (its child_workflow returns).
 * Deliberately a COOPERATIVE raise, NOT an external Dapr terminate (which can't
 * cross the per-session task hub → the known cross-app wedge). Direct (UI) goal
 * sessions have no workflow_execution_id and are left idle (emit-only).
 *
 * The eventName MUST be the semantic terminal type `session.terminate` for BOTH
 * runtimes — each runtime's `/internal/sessions/raise-event` endpoint:
 *   1. persists the cooperative-cancel flag when `eventName ∈ {session.terminate,
 *      user.interrupt}` (so the session_workflow halts on its idle-probe backstop
 *      even if the live event is missed/buffered mid-turn), AND
 *   2. re-wraps `{type: eventName, ...payload}` onto its own internal lifecycle
 *      channel (cli-agent-py LIFECYCLE_EVENT_NAME / dapr-agent-py user_events).
 * (Earlier code raised the CLI side with eventName="session.lifecycle_events" —
 * the channel name — so the endpoint saw a non-terminal eventName: it neither
 * persisted the flag NOR delivered a recognizable terminal type, and native-CLI
 * goal sessions hung after completing the goal. Always raise the TYPE, not the
 * channel.)
 */
async function terminateWorkflowGoalSessionIfNeeded(
	sessionId: string,
): Promise<void> {
	if (process.env.WORKFLOW_GOAL_AUTO_TERMINATE === "false") return;
	const workflowExecutionId = await getSessionWorkflowExecutionId(sessionId);
	if (!workflowExecutionId) return; // direct UI goal session → emit-only
	const res = await raiseSessionEvent(sessionId, "session.terminate", {
		reason: "goal_completed",
	});
	if (!res.ok) {
		console.warn(
			`[goal-loop] ${sessionId}: goal-complete terminate raise failed (${res.status}): ${res.error ?? ""}`,
		);
	}
}

async function driveContinuationIfIdle(
	sessionId: string,
	opts: { allowStaleIdleProbe?: boolean; kickoff?: boolean } = {},
): Promise<void> {
	// Emit the completion signal before the drivable-goal gate (a completed goal
	// is no longer "drivable", so this must run first). Idempotent.
	await emitGoalCompletedIfDone(sessionId);

	const goal = await getDrivableGoal(sessionId);
	if (!goal) return;

	// agy + non-CLI use the custom loop; only claude/codex drive their OWN native
	// `/goal` (and have no thread_goals row), so skip the BFF continuation driver
	// for them — it would fight the native loop.
	if (await sessionUsesNativeGoal(sessionId)) return;

	// Never drive a stopping/terminal session. If a stop was requested while a
	// goal is active, pause the goal so the loop stops re-posting.
	const stop = await sessionStopState(sessionId);
	if (!stop || stop.stopRequested || TERMINAL_SESSION_STATUSES.has(stop.status)) {
		if (stop?.stopRequested && goal.status === "active") {
			await pauseGoal(sessionId);
		}
		return;
	}

	// Only post when the session is genuinely idle: the latest event must be a
	// status_idle. This proves no turn is mid-flight AND that no newer
	// user.message (human input or an already-posted continuation) is queued.
	// The tick reaper additionally probes sessions whose event stream has been
	// frozen past the lost-idle grace — the idle event itself may have been
	// dropped while the BFF was down (ingest is fire-and-forget).
	const latest = await latestEventMeta(sessionId);
	if (!latest) return;
	const idle = latest.type === "session.status_idle";
	// Lost-idle backstop: only probe when the stream is genuinely frozen. The
	// telemetry-filtered `latest` can look stale during a long custom-loop turn
	// that emits only telemetry (no status_idle) — so ALSO require the RAW latest
	// event (any type, incl. telemetry) to be past the grace. If raw events are
	// still arriving the agent is alive and we must NOT inject (it would duplicate
	// the goal-continuation user.message mid-turn).
	let staleProbe =
		opts.allowStaleIdleProbe === true &&
		latest.ageSeconds >= LOST_IDLE_GRACE_SECONDS;
	if (staleProbe) {
		const rawAge = await rawLatestEventAgeSeconds(sessionId);
		if (rawAge !== null && rawAge < LOST_IDLE_GRACE_SECONDS) staleProbe = false;
	}
	// Kickoff bypass: when a goal is freshly set (iteration 0, no continuation yet)
	// there is no turn in flight, so post continuation #1 immediately instead of
	// waiting for a status_idle. This removes the slow first-turn start for CLIs
	// that don't emit an idle before their first turn (agy) — the raise is
	// Dapr-buffered until the composer is ready, exactly like native /goal.
	const kickoff =
		opts.kickoff === true && goal.iterations === 0 && !goal.lastContinuationAt;
	if (!idle && !staleProbe && !kickoff) return;
	if (!idle && staleProbe) {
		console.warn(
			`[goal-loop] ${sessionId}: lost-idle probe (latest=${latest.type}, age=${Math.round(latest.ageSeconds)}s) — posting continuation; Dapr buffers it if a turn is still running`,
		);
	}

	if (goal.status === "active") {
		if (goal.iterations >= goal.maxIterations) {
			const capped = await claimIterationCap(sessionId);
			if (capped) await postGoalMessage(sessionId, capped, "wrapup");
			return;
		}
		const claimed = await claimNextContinuation(sessionId);
		if (!claimed) return; // raced, spacing guard, or cap
		await postGoalMessage(sessionId, claimed, "continuation");
		return;
	}

	if (goal.status === "budget_limited") {
		const steered = await claimBudgetSteer(sessionId);
		if (steered) {
			await postGoalMessage(sessionId, steered, "wrapup");
			return;
		}
		// Already wrapped up and still budget_limited (token budget exhausted OR
		// iteration cap hit — the cap path flips status to budget_limited). The
		// goal won't reach `complete` on its own, so a WORKFLOW-driven session
		// would idle forever and wedge its parent durable/run. Terminate it (the
		// helper no-ops for direct UI sessions) so the parent resumes with the
		// agent's wrap-up output instead of hanging until the reaper.
		await terminateWorkflowGoalSessionIfNeeded(sessionId);
		return;
	}
}

async function postGoalMessage(
	sessionId: string,
	goal: ThreadGoalRow,
	kind: "continuation" | "wrapup",
): Promise<void> {
	const text =
		kind === "continuation"
			? renderContinuationPrompt(toBudgetView(goal))
			: renderBudgetLimitPrompt(toBudgetView(goal));
	const sourceEventId =
		kind === "continuation"
			? `goal-continuation:${sessionId}:${goal.iterations}`
			: `goal-wrapup:${sessionId}:${goal.goalId}`;
	// The continuation/wrap-up is a normal user.message carrying the rendered
	// prompt. `origin` lets the UI style/hide it like codex's hidden
	// continuation turns; the agent ignores the extra fields.
	const userMessage = {
		type: "user.message",
		content: [{ type: "text", text }],
		origin: "goal-continuation",
		goalKind: kind,
		goalIteration: goal.iterations,
	};
	await appendEvent(sessionId, {
		type: "user.message",
		data: userMessage,
		processedAt: null,
		sourceEventId,
	});
	await raiseSessionUserEvents(sessionId, [userMessage]);
}

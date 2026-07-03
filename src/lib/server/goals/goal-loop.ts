import { appendSessionEvent } from "$lib/server/application/adapters/session-events";
import { raiseSessionUserEvents } from "$lib/server/sessions/spawn";
import { raiseSessionEvent } from "$lib/server/sessions/control";
import { PostgresGoalLoopStore } from "$lib/server/application/adapters/goal-loop-store";
import type {
	GoalLoopStore,
	SessionGoalRecord,
} from "$lib/server/application/ports";
import { evaluateGoalCompletion } from "./evaluator";
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
 * sourceEventId, so inline hooks and explicit goal kicks never double-drive.
 */

const TERMINAL_SESSION_STATUSES = new Set([
	"terminated",
	"completed",
	"failed",
	"canceled",
	"cancelled",
]);

const defaultGoalLoopStore = new PostgresGoalLoopStore();

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

function toBudgetView(goal: SessionGoalRecord): GoalBudgetView {
	return {
		objective: goal.objective,
		tokensUsed: goal.tokensUsed,
		tokenBudget: goal.tokenBudget,
		timeUsedSeconds: goal.timeUsedSeconds,
	};
}

/**
 * Entry point invoked from the session event-log adapter side-effect block for
 * the event types the loop cares about. Fire-and-forget; never throws into the
 * caller.
 */
export async function onSessionEvent(
	sessionId: string,
	event: { type: string; data?: Record<string, unknown> },
	store: GoalLoopStore = defaultGoalLoopStore,
): Promise<void> {
	try {
		if (event.type === "agent.llm_usage") {
			const goal = await store.getDrivableGoal(sessionId);
			if (!goal) return;
			const delta = tokensFromUsage(event.data);
			if (delta > 0) await store.accrueUsage(sessionId, delta);
			return;
		}
		if (event.type === "session.status_idle") {
			const reason = (
				event.data?.stop_reason as { type?: string } | undefined
			)?.type;
			// Only an end_turn idle (the agent finished its turn) drives a
			// continuation. Terminal idles (max_iters, etc.) are ignored.
			if (reason && reason !== "end_turn") return;
			// Idle-rescue: a session with a recorded goal_completed but no thread_goals
			// row is an opt-in native `/goal` run (the vendor CLI emitted completion);
			// re-fire the cooperative terminate on this clean idle boundary so the
			// parent durable/run isn't wedged. Evaluator-mode sessions (the default,
			// which HAVE a row) are driven by driveContinuationIfIdle below instead.
			if (await store.hasGoalCompletedEvent(sessionId)) {
				await terminateWorkflowGoalSessionIfNeeded(sessionId, store);
				return;
			}
			await driveContinuationIfIdle(sessionId, {}, store);
			return;
		}
		if (event.type === "session.goal_completed") {
			// A goal_completed event is authoritative: evaluator-mode completion only
			// emits it AFTER the evaluator passed (via the update_goal MCP fast path or
			// the idle evidence backstop), and native `/goal` emits it from the vendor
			// CLI. Workflow-driven sessions must end so the parent durable/run resumes;
			// direct (UI) sessions stay idle (the helper no-ops without a workflow).
			await terminateWorkflowGoalSessionIfNeeded(sessionId, store);
			return;
		}
	} catch (err) {
		console.warn(`[goal-loop] onSessionEvent(${event.type}) failed:`, err);
	}
}

/**
 * Kick the loop outside of an idle event — used by the session goal API after
 * a human sets a goal on an already-idle session and by stop-hook evaluation.
 * Safe to call repeatedly (the idle gate + atomic claim dedupe).
 */
export async function kickGoalLoop(
	sessionId: string,
	opts: { kickoff?: boolean; fromStopHook?: boolean } = {},
	store: GoalLoopStore = defaultGoalLoopStore,
): Promise<void> {
	try {
		await driveContinuationIfIdle(sessionId, opts, store);
	} catch (err) {
		console.warn(`[goal-loop] kickGoalLoop failed:`, err);
	}
}

/**
 * Finalize a workflow-driven session whose goal is already COMPLETE but which
 * hasn't terminated. Covers a custom-loop agent that marked the goal complete
 * via the goal MCP and then DIDN'T idle (its TUI went silent mid-turn), so the
 * idle-gated emit→terminate never fired and the parent durable/run wedged. Both
 * calls are idempotent (emit dedupes on sourceEventId; terminate raise is a
 * no-op on an already-ending session).
 */
export async function finalizeCompletedWorkflowGoal(
	sessionId: string,
	store: GoalLoopStore = defaultGoalLoopStore,
): Promise<void> {
	try {
		// Emits session.goal_completed if the goal is complete (→ onSessionEvent
		// fires terminate). The explicit terminate below is the belt-and-suspenders
		// path when the event already exists (sourceEventId dedupe skips side
		// effects, so onSessionEvent would not re-fire).
		await emitGoalCompletedIfDone(sessionId, store);
		await terminateWorkflowGoalSessionIfNeeded(sessionId, store);
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
async function emitGoalCompletedIfDone(
	sessionId: string,
	store: GoalLoopStore = defaultGoalLoopStore,
): Promise<void> {
	const goal = await store.getCurrentGoal(sessionId);
	if (!goal || goal.status !== "complete") return;
	await appendSessionEvent(sessionId, {
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
	store: GoalLoopStore = defaultGoalLoopStore,
): Promise<void> {
	if (process.env.WORKFLOW_GOAL_AUTO_TERMINATE === "false") return;
	const workflowExecutionId = await store.getSessionWorkflowExecutionId(sessionId);
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

/** True iff this session is a native-goal CLI (codex/claude) that ALSO has a
 *  goal row with declared evidence — i.e. its completion is evaluator-gated by
 *  the BFF rather than the CLI's own /goal evaluator. */
/**
 * Inject an evaluator rejection into a goal session: record it (so the UI +
 * transcript show it, and a CLI's injected-prompt hook skips re-recording) and
 * raise it as a user turn so the agent keeps working. Runtime-agnostic — used by
 * the idle evidence backstop for dapr/agy/codex/claude alike.
 */
async function postEvidenceRejection(
	sessionId: string,
	goal: SessionGoalRecord,
	verdict: { feedback: string; results?: unknown[] },
): Promise<void> {
	const text =
		"Your goal was reported complete, but an INDEPENDENT verifier ran the " +
		"acceptance checks against the workspace and they did NOT pass. The goal " +
		`is NOT complete.\n\n${verdict.feedback}\n\nFix the issues in the ` +
		"workspace and keep working until every acceptance check passes.";
	const userMessage = {
		type: "user.message",
		content: [{ type: "text", text }],
		origin: "goal-evidence-reject",
		goalIteration: goal.iterations,
	};
	await appendSessionEvent(sessionId, {
		type: "user.message",
		data: userMessage,
		processedAt: null,
		sourceEventId: `goal-evidence-reject:${sessionId}:${goal.iterations}`,
	});
	await appendSessionEvent(sessionId, {
		type: "session.goal_rejected",
		data: {
			feedback: verdict.feedback,
			iteration: goal.iterations,
			results: verdict.results,
		},
		processedAt: null,
		sourceEventId: `goal-rejected:${sessionId}:${goal.iterations}`,
	});
	await raiseSessionUserEvents(sessionId, [userMessage]);
}

async function driveContinuationIfIdle(
	sessionId: string,
	opts: { kickoff?: boolean; fromStopHook?: boolean } = {},
	store: GoalLoopStore = defaultGoalLoopStore,
): Promise<void> {
	// Emit the completion signal before the drivable-goal gate (a completed goal
	// is no longer "drivable", so this must run first). Idempotent.
	await emitGoalCompletedIfDone(sessionId, store);

	const goal = await store.getDrivableGoal(sessionId);
	if (!goal) return;
	// A drivable thread_goals row == evaluator mode (the default for EVERY runtime,
	// incl. codex/claude). Native `/goal` runs have no row, so they never reach
	// here (getDrivableGoal returned null) — the vendor CLI drives those itself.

	// Never drive a stopping/terminal session. If a stop was requested while a
	// goal is active, pause the goal so the loop stops re-posting.
	const stop = await store.sessionStopState(sessionId);
	if (!stop || stop.stopRequested || TERMINAL_SESSION_STATUSES.has(stop.status)) {
		if (stop?.stopRequested && goal.status === "active") {
			await store.pauseGoal(sessionId);
		}
		return;
	}

	// Only post when the session is genuinely idle: the latest event must be a
	// status_idle. This proves no turn is mid-flight AND that no newer
	// user.message (human input or an already-posted continuation) is queued.
	const latest = await store.latestEventMeta(sessionId);
	if (!latest) return;
	const idle = latest.type === "session.status_idle";
	// Kickoff bypass: when a goal is freshly set (iteration 0, no continuation yet)
	// there is no turn in flight, so post continuation #1 immediately instead of
	// waiting for a status_idle. This removes the slow first-turn start for CLIs
	// that don't emit an idle before their first turn (agy) — the raise is
	// Dapr-buffered until the composer is ready, exactly like native /goal.
	const kickoff =
		opts.kickoff === true && goal.iterations === 0 && !goal.lastContinuationAt;
	// fromStopHook: the dapr-agent-py Stop hook fires synchronously at the end of a
	// real turn (after the agent loop completes), BEFORE the idle event is emitted —
	// so it's a valid forced drive even though the latest event isn't yet a
	// status_idle. Bypass only the idle gate; every other guard (drivable-goal,
	// stop-state, claimNextContinuation spacing/claim, evidence backstop) still
	// applies, and exactly-once is preserved by the atomic claim + sourceEventId.
	if (!idle && !kickoff && !opts.fromStopHook) return;

	if (goal.status === "active") {
		if (goal.iterations >= goal.maxIterations) {
			const capped = await store.claimIterationCap(sessionId);
			if (capped) await postGoalMessage(sessionId, capped, "wrapup");
			return;
		}
		// Evidence backstop: when the goal declares deterministic evidence the BFF
		// evaluator is the completion AUTHORITY — verify ground-truth workspace
		// state on each idle rather than depending on the agent calling update_goal
		// (the MCP update_goal → /evaluate path is the fast path; this is the
		// backstop, and the only completion path for agents that finish silently).
		// Skip the kickoff turn (no work done yet). Met → complete; not met →
		// continue with the exact failing checks fed back. Runtime-agnostic.
		const hasEvidence = !!goal.evidencePlan?.commands?.length;
		if (hasEvidence && !kickoff) {
			const verdict = await evaluateGoalCompletion(sessionId);
			if (verdict.met) {
				await store.markGoalComplete(sessionId);
				await emitGoalCompletedIfDone(sessionId, store);
				await terminateWorkflowGoalSessionIfNeeded(sessionId, store);
				return;
			}
			const claimed = await store.claimNextContinuation(sessionId);
			if (!claimed) return; // raced, spacing guard, or cap (next idle wraps up)
			await postEvidenceRejection(sessionId, claimed, verdict);
			return;
		}
		const claimed = await store.claimNextContinuation(sessionId);
		if (!claimed) return; // raced, spacing guard, or cap
		await postGoalMessage(sessionId, claimed, "continuation");
		return;
	}

	if (goal.status === "budget_limited") {
		const steered = await store.claimBudgetSteer(sessionId);
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
		await terminateWorkflowGoalSessionIfNeeded(sessionId, store);
		return;
	}
}

async function postGoalMessage(
	sessionId: string,
	goal: SessionGoalRecord,
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
	await appendSessionEvent(sessionId, {
		type: "user.message",
		data: userMessage,
		processedAt: null,
		sourceEventId,
	});
	await raiseSessionUserEvents(sessionId, [userMessage]);
}

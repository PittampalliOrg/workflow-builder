import { appendEvent } from "$lib/server/sessions/events";
import { raiseSessionUserEvents } from "$lib/server/sessions/spawn";
import type { ThreadGoalRow } from "$lib/server/db/schema";
import {
	accrueUsage,
	claimBudgetSteer,
	claimIterationCap,
	claimNextContinuation,
	getDrivableGoal,
	latestEventType,
	pauseGoal,
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

function tokensFromUsage(data: Record<string, unknown> | undefined): number {
	const n = (key: string): number => {
		const v = Math.round(Number(data?.[key] ?? 0));
		return Number.isFinite(v) && v > 0 ? v : 0;
	};
	return (
		n("input_tokens") +
		n("output_tokens") +
		n("cache_read_input_tokens") +
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
			await driveContinuationIfIdle(sessionId);
			return;
		}
	} catch (err) {
		console.warn(`[goal-loop] onSessionEvent(${event.type}) failed:`, err);
	}
}

/**
 * Kick the loop outside of an idle event — used by the session goal API after
 * a human sets a goal on an already-idle session, and by the tick reaper
 * backstop. Safe to call repeatedly (the idle gate + atomic claim dedupe).
 */
export async function kickGoalLoop(sessionId: string): Promise<void> {
	try {
		await driveContinuationIfIdle(sessionId);
	} catch (err) {
		console.warn(`[goal-loop] kickGoalLoop failed:`, err);
	}
}

async function driveContinuationIfIdle(sessionId: string): Promise<void> {
	const goal = await getDrivableGoal(sessionId);
	if (!goal) return;

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
	const latest = await latestEventType(sessionId);
	if (latest !== "session.status_idle") return;

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
		if (steered) await postGoalMessage(sessionId, steered, "wrapup");
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

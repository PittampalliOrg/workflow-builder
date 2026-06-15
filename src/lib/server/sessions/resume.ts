/**
 * Interactive-CLI session RESUME predicates (Phase 2a).
 *
 * The CLI/JuiceFS family persists its conversation transcript on a per-session
 * Postgres-backed JuiceFS subtree (reclaim=Retain), so the bytes survive ANY
 * exit — a clean `claude` end-of-turn, a SIGKILL, an OOM, a node failure, or an
 * image-pin rollout. Resume re-mounts the same subPath and runs
 * `claude --continue`, so a crashed conversation is exactly as resumable as a
 * gracefully-terminated one.
 *
 * The original gate (`src/routes/api/v1/sessions/+server.ts`) allowed resume
 * ONLY when `source.status === "terminated"`. That rejected a session that
 * crashed non-gracefully (left `failed`/`error`, or still showing
 * `running`/`idle` until the lifecycle reaper converges it ~10–75 min later) —
 * even though its transcript is safe and resumable. This module relaxes the
 * precondition: a non-graceful exit is resumable too.
 *
 * Pure (no DB / Dapr / I/O) so it is unit-testable and reusable by both the
 * manual resume route and the auto-resume reconciler (see ../lifecycle/auto-resume.ts).
 */
/**
 * Free-text `sessions.status` values a CLI session can land in after a
 * NON-GRACEFUL exit. The TS `SessionStatus` union doesn't list these, but the
 * DB column is `text`, so a crash path may persist one of them.
 */
export const NON_GRACEFUL_TERMINAL_STATUSES = ["failed", "error", "crashed"] as const;

/** `stopReason.type` values that mean the run ended cleanly (graceful). */
const GRACEFUL_STOP_TYPES = new Set([
	"end_turn",
	"completed",
	"auto_terminate_after_end_turn",
]);

/**
 * Loose structural shape of a runtime descriptor — only the two fields this
 * module reads. Accepts the full `RuntimeDescriptor` (it has both) as well as
 * the minimal objects the reconciler / tests construct.
 */
type RuntimeLike =
	| { family?: string | null; capabilities?: { interactiveTerminal?: boolean | null } | null }
	| null
	| undefined;
type StopReasonLike = { type?: string | null } | Record<string, unknown> | null | undefined;

export function isInteractiveCliRuntime(runtime: RuntimeLike): boolean {
	if (!runtime) return false;
	return (
		runtime.family === "interactive-cli" ||
		runtime.capabilities?.interactiveTerminal === true
	);
}

/**
 * True when a session's exit was NON-graceful (crash/kill/timeout/error) rather
 * than a clean end-of-turn. Used to decide auto-resume eligibility and to label
 * the resume.
 */
export function isNonGracefulExit(input: {
	status: string;
	stopReason?: StopReasonLike;
	errorMessage?: string | null;
}): boolean {
	const status = (input.status || "").toLowerCase();
	if ((NON_GRACEFUL_TERMINAL_STATUSES as readonly string[]).includes(status)) {
		return true;
	}
	if (input.errorMessage && String(input.errorMessage).trim()) return true;
	const stopReason = input.stopReason;
	const stopType =
		stopReason && typeof stopReason === "object"
			? String((stopReason as { type?: unknown }).type ?? "").toLowerCase()
			: "";
	// interrupted / terminated-by-host / error / host_timeout / iteration_cap, etc.
	if (stopType && !GRACEFUL_STOP_TYPES.has(stopType)) return true;
	return false;
}

export type ResumeDecision = {
	allowed: boolean;
	/** Set when not allowed — a human-readable 4xx detail. */
	reason?: string;
	/** True when the (allowed) resume is recovering a non-graceful exit. */
	nonGraceful: boolean;
};

/**
 * Decide whether an interactive-cli session may be resumed.
 *
 * Allowed when the runtime is interactive-cli AND the conversation is no longer
 * live — i.e. it reached a terminal status (`terminated` OR a non-graceful
 * `failed`/`error`/`crashed`), OR the caller supplies positive evidence that the
 * sandbox is gone (`runtimeGone`, used by the auto-resume reconciler before the
 * DB status has converged). This is the relaxation over the old
 * `status === "terminated"`-only gate.
 */
export function canResumeCliSession(input: {
	runtime: RuntimeLike;
	status: string;
	stopReason?: StopReasonLike;
	errorMessage?: string | null;
	/** Positive evidence the runtime/sandbox is gone even if status hasn't converged. */
	runtimeGone?: boolean;
}): ResumeDecision {
	if (!isInteractiveCliRuntime(input.runtime)) {
		return {
			allowed: false,
			reason: "resume is only supported for interactive-cli sessions",
			nonGraceful: false,
		};
	}
	const status = (input.status || "").toLowerCase();
	const nonGraceful = isNonGracefulExit({
		status,
		stopReason: input.stopReason,
		errorMessage: input.errorMessage,
	});
	const terminal =
		status === "terminated" ||
		(NON_GRACEFUL_TERMINAL_STATUSES as readonly string[]).includes(status);
	if (!terminal && input.runtimeGone !== true) {
		return {
			allowed: false,
			reason: "can only resume a terminated or crashed interactive-cli session",
			nonGraceful,
		};
	}
	return { allowed: true, nonGraceful };
}

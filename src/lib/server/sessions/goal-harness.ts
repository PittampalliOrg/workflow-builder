// CLI adapters whose vendor CLI has a REAL native `/goal` harness (multi-turn
// loop + completion evaluator/marker). Antigravity's `/goal` is a thin command
// with no detectable completion, so agy has no native harness.
const NATIVE_GOAL_CLI_ADAPTERS = new Set(['claude-code', 'codex']);

/** Does this runtime have a native `/goal` harness *available*? (claude/codex
 *  interactive CLIs). This is a capability check, not "native is the default". */
export function runtimeHasNativeGoalHarness(
	descriptor: { family?: string; cliAdapter?: string } | null | undefined,
): boolean {
	return (
		descriptor?.family === 'interactive-cli' &&
		!!descriptor.cliAdapter &&
		NATIVE_GOAL_CLI_ADAPTERS.has(descriptor.cliAdapter)
	);
}

/** Rollback switch: when true, claude/codex default back to native `/goal`. */
export function goalNativeByDefault(): boolean {
	return process.env.GOAL_NATIVE_BY_DEFAULT === 'true';
}

/** The user explicitly asked for native `/goal` by prefixing the objective. */
export function goalObjectiveRequestsNative(objective: string): boolean {
	return /^\/goal(\s|$)/.test(objective.trimStart());
}

/** Strip a leading `/goal ` so the clean objective is reused in either mode. */
export function stripNativeGoalPrefix(objective: string): string {
	return objective.replace(/^\s*\/goal\s*/, '').trim();
}

/**
 * Single source of truth for the native-vs-evaluator decision, used by every
 * goal-setting surface. Returns the cleaned objective and whether to use the
 * native harness.
 */
export function decideGoalHarness(
	rawObjective: string,
	hasNativeHarness: boolean,
): { native: boolean; objective: string } {
	const objective = stripNativeGoalPrefix(rawObjective);
	const native =
		hasNativeHarness &&
		(goalObjectiveRequestsNative(rawObjective) || goalNativeByDefault());
	return { native, objective };
}

/**
 * Fork/resume step model for the ForkDialog step picker + reuse summary.
 *
 * A run's forkable steps are its completed top-level nodes (SW canvas nodes) or
 * dynamic-script calls, in execution order. Dynamic-script calls also carry
 * per-call token usage, which lets the dialog report how much prior work a fork
 * REUSES (the skipped prefix). SW runs have no per-step usage, so the summary
 * degrades to a step count.
 */

export type ForkStep = {
	/** Bare step id the resume API keys on (node name / call id). */
	id: string;
	label: string;
	/** 0-based position in execution order. */
	index: number;
	/** Tokens consumed by this step, when known (dynamic-script calls). */
	tokens: number | null;
	/** The step where a failed run stopped (drives the "failed here" marker). */
	isFailed: boolean;
};

export type ScriptCallLike = {
	label: string | null;
	seq: number;
	tokensUsed: number;
	status: string;
};

/**
 * Build the ordered forkable-step list from the run's node ids, augmenting each
 * with dynamic-script per-call token usage when available (matched by execution
 * order). `scriptCalls` may be null/empty for SW runs.
 */
export function buildForkSteps(
	nodeIds: string[],
	scriptCalls: ScriptCallLike[] | null | undefined,
	failedNodeId?: string | null
): ForkStep[] {
	const calls = (scriptCalls ?? []).slice().sort((a, b) => a.seq - b.seq);
	return nodeIds.map((id, index) => {
		const call = calls[index];
		return {
			id,
			label: call?.label ?? id,
			index,
			tokens: call && typeof call.tokensUsed === 'number' ? call.tokensUsed : null,
			isFailed: !!failedNodeId && id === failedNodeId
		};
	});
}

export type ReuseSummary = {
	/** Number of skipped (reused) steps. */
	stepCount: number;
	/** Total tokens reused, or null when no per-step usage is known. */
	tokens: number | null;
};

/**
 * Summarize the prefix a fork REUSES: steps before `selectedIndex`. Tokens are
 * summed only when at least one skipped step reports usage; otherwise null so the
 * UI can fall back to the step count.
 */
export function summarizeReuse(steps: ForkStep[], selectedIndex: number): ReuseSummary {
	if (selectedIndex <= 0) return { stepCount: 0, tokens: null };
	const skipped = steps.slice(0, selectedIndex);
	let tokens: number | null = null;
	for (const step of skipped) {
		if (typeof step.tokens === 'number') tokens = (tokens ?? 0) + step.tokens;
	}
	return { stepCount: skipped.length, tokens };
}

/** Split steps into skipped (reused) vs re-run at the selected fork point. */
export function splitAtFork(
	steps: ForkStep[],
	selectedStepId: string | null
): { skipped: ForkStep[]; rerun: ForkStep[]; selectedIndex: number } {
	const idx = selectedStepId ? steps.findIndex((s) => s.id === selectedStepId) : -1;
	if (idx < 0) return { skipped: [], rerun: steps, selectedIndex: -1 };
	return { skipped: steps.slice(0, idx), rerun: steps.slice(idx), selectedIndex: idx };
}

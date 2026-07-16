/**
 * Pure helpers for the dashboard Run activity panel.
 *
 * Status matching, filter-count derivation, and the visible-result limit live
 * here so they are unit-testable without a DOM. The dashboard page imports
 * these and keeps all I/O (fetch, rendering) in the component.
 */

export type RunStatus = "pending" | "running" | "success" | "error" | "cancelled";

export type RunActivityFilter = "all" | "in-progress" | "failed" | "succeeded";

export type RunActivityRun = {
	executionId: string;
	workflowId: string;
	workflowName: string;
	status: RunStatus;
	startedAt: string;
	durationMs: number | null;
	sessionCount: number;
};

/** Filters offered by the Run activity panel, in display order. */
export const RUN_ACTIVITY_FILTERS: readonly RunActivityFilter[] = [
	"all",
	"in-progress",
	"failed",
	"succeeded",
] as const;

/** Human label for each filter (used by the ToggleGroup items). */
export const RUN_ACTIVITY_FILTER_LABELS: Record<RunActivityFilter, string> = {
	all: "All",
	"in-progress": "In progress",
	failed: "Failed",
	succeeded: "Succeeded",
};

/** Max runs fetched from /api/v1/runs for the panel. */
export const RUN_ACTIVITY_FETCH_LIMIT = 20;

/** Max runs rendered after filtering. */
export const RUN_ACTIVITY_VISIBLE_LIMIT = 5;

/**
 * True when a run matches the given filter.
 *
 * - all          → every status (including cancelled) is visible
 * - in-progress  → pending or running
 * - failed       → error
 * - succeeded    → success
 *
 * Cancelled runs are only visible under "all"; no filter selects them alone.
 */
export function matchesFilter(run: RunActivityRun, filter: RunActivityFilter): boolean {
	switch (filter) {
		case "all":
			return true;
		case "in-progress":
			return run.status === "pending" || run.status === "running";
		case "failed":
			return run.status === "error";
		case "succeeded":
			return run.status === "success";
	}
}

/**
 * Per-filter live counts for the full fetched set (not the visible slice).
 * Counts are independent of the currently selected filter so the ToggleGroup
 * can show badges for every option simultaneously.
 */
export function deriveFilterCounts(runs: readonly RunActivityRun[]): Record<RunActivityFilter, number> {
	const counts: Record<RunActivityFilter, number> = {
		all: runs.length,
		"in-progress": 0,
		failed: 0,
		succeeded: 0,
	};
	for (const run of runs) {
		if (run.status === "pending" || run.status === "running") counts["in-progress"]++;
		else if (run.status === "error") counts.failed++;
		else if (run.status === "success") counts.succeeded++;
	}
	return counts;
}

/**
 * Filter the fetched runs to the selected filter and return at most
 * {@link RUN_ACTIVITY_VISIBLE_LIMIT} most recent matches.
 *
 * The caller is expected to pass runs already ordered most-recent-first from
 * the API. We do not re-sort here — the /api/v1/runs endpoint returns
 * startedAt-descending order and re-sorting would mask an API regression in
 * tests. We only slice to the visible limit.
 */
export function selectVisibleRuns(
	runs: readonly RunActivityRun[],
	filter: RunActivityFilter,
): RunActivityRun[] {
	return runs
		.filter((run) => matchesFilter(run, filter))
		.slice(0, RUN_ACTIVITY_VISIBLE_LIMIT);
}

/**
 * Whether the selected filter has zero matching runs in the fetched set.
 * Used to decide between the filter empty-state (with a Reset action) and the
 * plain no-runs message.
 */
export function isFilterEmpty(
	runs: readonly RunActivityRun[],
	filter: RunActivityFilter,
): boolean {
	return deriveFilterCounts(runs)[filter] === 0;
}

import { describe, expect, it } from "vitest";
import {
	RUN_ACTIVITY_FILTERS,
	RUN_ACTIVITY_FETCH_LIMIT,
	RUN_ACTIVITY_VISIBLE_LIMIT,
	deriveFilterCounts,
	isFilterEmpty,
	matchesFilter,
	selectVisibleRuns,
	type RunActivityFilter,
	type RunActivityRun,
} from "./run-activity";

function run(
	executionId: string,
	status: RunActivityRun["status"],
	overrides: Partial<RunActivityRun> = {},
): RunActivityRun {
	return {
		executionId,
		workflowId: "wf-1",
		workflowName: "Example",
		status,
		startedAt: "2026-01-01T00:00:00.000Z",
		durationMs: null,
		sessionCount: 0,
		...overrides,
	};
}

// A set covering every status at least once.
const mixedRuns: RunActivityRun[] = [
	run("e-pending", "pending"),
	run("e-running", "running"),
	run("e-success", "success"),
	run("e-error", "error"),
	run("e-cancelled", "cancelled"),
];

describe("matchesFilter", () => {
	it("includes every status under 'all'", () => {
		for (const r of mixedRuns) {
			expect(matchesFilter(r, "all")).toBe(true);
		}
	});

	it("matches pending and running under 'in-progress'", () => {
		expect(matchesFilter(run("p", "pending"), "in-progress")).toBe(true);
		expect(matchesFilter(run("r", "running"), "in-progress")).toBe(true);
	});

	it("does not match success, error, or cancelled under 'in-progress'", () => {
		expect(matchesFilter(run("s", "success"), "in-progress")).toBe(false);
		expect(matchesFilter(run("e", "error"), "in-progress")).toBe(false);
		expect(matchesFilter(run("c", "cancelled"), "in-progress")).toBe(false);
	});

	it("matches only error under 'failed'", () => {
		expect(matchesFilter(run("e", "error"), "failed")).toBe(true);
		expect(matchesFilter(run("p", "pending"), "failed")).toBe(false);
		expect(matchesFilter(run("r", "running"), "failed")).toBe(false);
		expect(matchesFilter(run("s", "success"), "failed")).toBe(false);
		expect(matchesFilter(run("c", "cancelled"), "failed")).toBe(false);
	});

	it("matches only success under 'succeeded'", () => {
		expect(matchesFilter(run("s", "success"), "succeeded")).toBe(true);
		expect(matchesFilter(run("p", "pending"), "succeeded")).toBe(false);
		expect(matchesFilter(run("r", "running"), "succeeded")).toBe(false);
		expect(matchesFilter(run("e", "error"), "succeeded")).toBe(false);
		expect(matchesFilter(run("c", "cancelled"), "succeeded")).toBe(false);
	});

	it("never matches cancelled under any non-all filter", () => {
		const cancelled = run("c", "cancelled");
		expect(matchesFilter(cancelled, "in-progress")).toBe(false);
		expect(matchesFilter(cancelled, "failed")).toBe(false);
		expect(matchesFilter(cancelled, "succeeded")).toBe(false);
		// but visible under all
		expect(matchesFilter(cancelled, "all")).toBe(true);
	});

	it("covers every filter value for every status without falling through", () => {
		const statuses: RunActivityRun["status"][] = [
			"pending",
			"running",
			"success",
			"error",
			"cancelled",
		];
		const filters: RunActivityFilter[] = ["all", "in-progress", "failed", "succeeded"];
		// Exhaustive: every combination returns a boolean (no throw, no undefined).
		for (const status of statuses) {
			for (const filter of filters) {
				const result = matchesFilter(run("x", status), filter);
				expect(typeof result).toBe("boolean");
			}
		}
	});
});

describe("deriveFilterCounts", () => {
	it("counts each status bucket correctly for a mixed set", () => {
		expect(deriveFilterCounts(mixedRuns)).toEqual({
			all: 5,
			"in-progress": 2, // pending + running
			failed: 1, // error
			succeeded: 1, // success
		});
	});

	it("counts 'all' as the total length including cancelled", () => {
		const runs = [run("c1", "cancelled"), run("c2", "cancelled")];
		expect(deriveFilterCounts(runs)).toEqual({
			all: 2,
			"in-progress": 0,
			failed: 0,
			succeeded: 0,
		});
	});

	it("returns zero for every bucket on an empty set", () => {
		expect(deriveFilterCounts([])).toEqual({
			all: 0,
			"in-progress": 0,
			failed: 0,
			succeeded: 0,
		});
	});

	it("counts duplicate statuses correctly", () => {
		const runs = [
			run("r1", "running"),
			run("r2", "running"),
			run("r3", "running"),
			run("p1", "pending"),
			run("e1", "error"),
			run("e2", "error"),
		];
		expect(deriveFilterCounts(runs)).toEqual({
			all: 6,
			"in-progress": 4, // 3 running + 1 pending
			failed: 2,
			succeeded: 0,
		});
	});
});

describe("selectVisibleRuns", () => {
	it("returns all matching runs when fewer than the visible limit", () => {
		const result = selectVisibleRuns(mixedRuns, "in-progress");
		expect(result).toHaveLength(2);
		expect(result.map((r) => r.executionId)).toEqual(["e-pending", "e-running"]);
	});

	it("preserves input order (most-recent-first from API) without re-sorting", () => {
		const runs = [
			run("newest", "success", { startedAt: "2026-03-01T00:00:00.000Z" }),
			run("middle", "success", { startedAt: "2026-02-01T00:00:00.000Z" }),
			run("oldest", "success", { startedAt: "2026-01-01T00:00:00.000Z" }),
		];
		const result = selectVisibleRuns(runs, "succeeded");
		expect(result.map((r) => r.executionId)).toEqual(["newest", "middle", "oldest"]);
	});

	it("limits to exactly five results even when more match", () => {
		const runs = Array.from({ length: 10 }, (_, i) =>
			run(`e-${i}`, "running"),
		);
		const result = selectVisibleRuns(runs, "in-progress");
		expect(result).toHaveLength(RUN_ACTIVITY_VISIBLE_LIMIT);
		expect(result).toHaveLength(5);
		// First five in input order are kept.
		expect(result.map((r) => r.executionId)).toEqual([
			"e-0",
			"e-1",
			"e-2",
			"e-3",
			"e-4",
		]);
	});

	it("returns an empty array when no runs match the filter", () => {
		expect(selectVisibleRuns(mixedRuns, "succeeded")).toHaveLength(1);
		// Remove the only success to get an empty result.
		const noSuccess = mixedRuns.filter((r) => r.status !== "success");
		expect(selectVisibleRuns(noSuccess, "succeeded")).toEqual([]);
	});

	it("includes cancelled runs only under 'all'", () => {
		const runs = [run("c1", "cancelled"), run("c2", "cancelled")];
		expect(selectVisibleRuns(runs, "all")).toHaveLength(2);
		expect(selectVisibleRuns(runs, "in-progress")).toEqual([]);
		expect(selectVisibleRuns(runs, "failed")).toEqual([]);
		expect(selectVisibleRuns(runs, "succeeded")).toEqual([]);
	});

	it("applies the limit after filtering, not before", () => {
		// 6 success + 4 error. Under 'succeeded' we should get 5 (the limit),
		// under 'failed' we should get all 4.
		const runs = [
			...Array.from({ length: 6 }, (_, i) => run(`s-${i}`, "success")),
			...Array.from({ length: 4 }, (_, i) => run(`e-${i}`, "error")),
		];
		expect(selectVisibleRuns(runs, "succeeded")).toHaveLength(5);
		expect(selectVisibleRuns(runs, "failed")).toHaveLength(4);
	});
});

describe("isFilterEmpty", () => {
	it("is true when the selected filter has zero matching runs", () => {
		expect(isFilterEmpty(mixedRuns, "succeeded")).toBe(false); // has 1 success
		const noSuccess = mixedRuns.filter((r) => r.status !== "success");
		expect(isFilterEmpty(noSuccess, "succeeded")).toBe(true);
	});

	it("is false for 'all' when runs exist", () => {
		expect(isFilterEmpty(mixedRuns, "all")).toBe(false);
	});

	it("is true for 'all' when there are no runs at all", () => {
		expect(isFilterEmpty([], "all")).toBe(true);
	});
});

describe("constants", () => {
	it("exposes the four filters in display order", () => {
		expect(RUN_ACTIVITY_FILTERS).toEqual([
			"all",
			"in-progress",
			"failed",
			"succeeded",
		]);
	});

	it("fetches up to 20 runs", () => {
		expect(RUN_ACTIVITY_FETCH_LIMIT).toBe(20);
	});

	it("shows at most five runs", () => {
		expect(RUN_ACTIVITY_VISIBLE_LIMIT).toBe(5);
	});
});

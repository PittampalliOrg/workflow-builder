import { describe, expect, it, vi } from "vitest";
import {
	type DurableCascadeDeps,
	dedupeAgentRuntimeTargets,
	durableRuntimeStatusFromBody,
	isTerminalDurableRuntimeStatus,
	runDurableCascade,
	runWithConcurrency,
} from "./cascade";

function makeDeps(overrides: Partial<DurableCascadeDeps> = {}): DurableCascadeDeps {
	return {
		getParentStatus: vi.fn(async () => "RUNNING"),
		terminateParent: vi.fn(async () => "terminated" as const),
		waitParentClosed: vi.fn(async () => true),
		getAgentRuntimeStatus: vi.fn(async () => "RUNNING"),
		terminateAgentRuntime: vi.fn(async () => "terminated" as const),
		waitAgentRuntimeClosed: vi.fn(async () => true),
		purgeParent: vi.fn(async () => {}),
		purgeAgentRuntime: vi.fn(async () => {}),
		purgeStateRows: vi.fn(async () => {}),
		sleep: vi.fn(async () => {}),
		...overrides,
	};
}

describe("pure helpers", () => {
	it("isTerminalDurableRuntimeStatus matches terminal states case-insensitively", () => {
		for (const s of ["COMPLETED", "failed", "Terminated", "CANCELLED", "canceled"]) {
			expect(isTerminalDurableRuntimeStatus(s)).toBe(true);
		}
		for (const s of ["RUNNING", "PENDING", "SUSPENDED", "", null, undefined]) {
			expect(isTerminalDurableRuntimeStatus(s)).toBe(false);
		}
	});

	it("durableRuntimeStatusFromBody unwraps nested status shapes", () => {
		expect(durableRuntimeStatusFromBody({ runtimeStatus: "RUNNING" })).toBe("RUNNING");
		expect(durableRuntimeStatusFromBody({ runtime_status: "FAILED" })).toBe("FAILED");
		expect(durableRuntimeStatusFromBody({ status: { runtimeStatus: "COMPLETED" } })).toBe(
			"COMPLETED",
		);
		expect(durableRuntimeStatusFromBody(null)).toBeNull();
	});

	it("dedupeAgentRuntimeTargets drops blanks + duplicates", () => {
		expect(
			dedupeAgentRuntimeTargets([
				{ runtimeAppId: "a", instanceId: "1" },
				{ runtimeAppId: "a", instanceId: "1" },
				{ runtimeAppId: " ", instanceId: "1" },
				{ runtimeAppId: "a", instanceId: "2" },
			]),
		).toEqual([
			{ runtimeAppId: "a", instanceId: "1" },
			{ runtimeAppId: "a", instanceId: "2" },
		]);
	});

	it("runWithConcurrency runs every item", async () => {
		const seen: number[] = [];
		await runWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
			seen.push(n);
		});
		expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
	});
});

describe("runDurableCascade", () => {
	it("terminates then purges parent + agent runtimes when all close", async () => {
		const deps = makeDeps();
		const result = await runDurableCascade({
			parentInstanceIds: ["p1"],
			agentRuntimeTargets: [{ runtimeAppId: "app", instanceId: "i1" }],
			reason: "test",
			purge: true,
			purgeGraceMs: 0,
			deps,
		});
		expect(result.allClosed).toBe(true);
		expect(deps.terminateParent).toHaveBeenCalledWith("p1", "test");
		expect(deps.terminateAgentRuntime).toHaveBeenCalledWith("app", "i1", "test");
		expect(deps.purgeParent).toHaveBeenCalledWith("p1");
		expect(deps.purgeAgentRuntime).toHaveBeenCalledWith("app", "i1");
		expect(deps.purgeStateRows).toHaveBeenCalledTimes(1);
	});

	it("is fail-closed: does not purge when a terminate fails", async () => {
		const deps = makeDeps({
			terminateParent: vi.fn(async () => "failed" as const),
			waitParentClosed: vi.fn(async () => false),
		});
		const result = await runDurableCascade({
			parentInstanceIds: ["p1"],
			agentRuntimeTargets: [],
			reason: "test",
			purge: true,
			purgeGraceMs: 0,
			deps,
		});
		expect(result.allClosed).toBe(false);
		expect(deps.purgeParent).not.toHaveBeenCalled();
		expect(deps.purgeStateRows).not.toHaveBeenCalled();
	});

	it("force-purges scoped state rows when unclosed + forceStatePurgeOnUnclosed", async () => {
		const deps = makeDeps({
			terminateParent: vi.fn(async () => "failed" as const),
			waitParentClosed: vi.fn(async () => false),
		});
		const result = await runDurableCascade({
			parentInstanceIds: ["p1"],
			agentRuntimeTargets: [],
			reason: "test",
			purge: true,
			purgeGraceMs: 0,
			forceStatePurgeOnUnclosed: true,
			deps,
		});
		expect(result.allClosed).toBe(true);
		expect(deps.purgeStateRows).toHaveBeenCalledTimes(1);
		// the normal recursive purge of the parent is skipped on the force path
		expect(deps.purgeParent).not.toHaveBeenCalled();
	});

	it("skips terminate for already-terminal instances but still purges them", async () => {
		const deps = makeDeps({
			getParentStatus: vi.fn(async () => "COMPLETED"),
		});
		const result = await runDurableCascade({
			parentInstanceIds: ["p1"],
			agentRuntimeTargets: [],
			reason: "test",
			purge: true,
			purgeGraceMs: 0,
			deps,
		});
		expect(result.allClosed).toBe(true);
		expect(deps.terminateParent).not.toHaveBeenCalled();
		expect(deps.purgeParent).toHaveBeenCalledWith("p1");
	});

	it("does not purge when purge=false (terminate-only)", async () => {
		const deps = makeDeps();
		const result = await runDurableCascade({
			parentInstanceIds: ["p1"],
			agentRuntimeTargets: [],
			reason: "test",
			purge: false,
			purgeGraceMs: 0,
			deps,
		});
		expect(result.allClosed).toBe(true);
		expect(deps.terminateParent).toHaveBeenCalledTimes(1);
		expect(deps.purgeParent).not.toHaveBeenCalled();
	});
});

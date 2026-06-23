import { describe, expect, it, vi } from "vitest";
import {
	type DurableCascadeDeps,
	daprStateKeyMatchPattern,
	dedupeAgentRuntimeTargets,
	durableRuntimeStatusFromBody,
	isTerminalDurableRuntimeStatus,
	runDurableCascade,
	runWithConcurrency,
	shouldForceFinalizeCrossAppWedge,
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

describe("daprStateKeyMatchPattern (GAP-4: boundary-anchored, no sibling over-delete)", () => {
	const matches = (key: string, id: string) =>
		new RegExp(daprStateKeyMatchPattern(id)).test(key.toLowerCase());

	it("matches wfstate history + metadata keys for the exact instance", () => {
		const id = "sw-x-exec-ABC";
		expect(matches("workflow-orchestrator||dapr.internal.x.workflow||sw-x-exec-ABC||history-15", id)).toBe(true);
		expect(matches("workflow-orchestrator||dapr.internal.x.workflow||sw-x-exec-ABC", id)).toBe(true);
	});

	it("matches __turn__ sub-instances of a run instance", () => {
		const id = "sw-x-exec-ABC__durable__node__run__0";
		expect(matches("agent-session-1||x.workflow||sw-x-exec-ABC__durable__node__run__0__turn__1||history-2", id)).toBe(true);
	});

	it("matches agent_py_state _workflow_ keys (lowercased id)", () => {
		const id = "sw-x-exec-ABC__durable__node__run__0";
		expect(matches("dapr-agent-py||dapr-agent-py:_workflow_sw-x-exec-abc__durable__node__run__0", id)).toBe(true);
	});

	it("does NOT match a sibling whose index is a prefix superset", () => {
		const id = "sw-x-exec-ABC__durable__node__run__1";
		expect(matches("agent-session-1||x.workflow||sw-x-exec-ABC__durable__node__run__10__turn__1||history-2", id)).toBe(false);
		expect(matches("agent-session-1||x.workflow||sw-x-exec-ABC__durable__node__run__11", id)).toBe(false);
	});

	it("does NOT match a different instance", () => {
		expect(matches("workflow-orchestrator||x.workflow||sw-x-exec-XYZ||history-1", "sw-x-exec-ABC")).toBe(false);
	});
});

describe("shouldForceFinalizeCrossAppWedge", () => {
	const now = 1_000_000;
	const graceMs = 180_000;
	// Positive evidence: parent parked at a node whose child session is terminated.
	const base = {
		stopRequestedAt: new Date(now - graceMs - 1),
		nowMs: now,
		graceMs,
		parentCurrentNode: "build_3b1b_animation",
		terminatedChildNodes: ["build_3b1b_animation"],
	};

	it("fires: parent parked at a terminated child's node, grace elapsed", () => {
		expect(shouldForceFinalizeCrossAppWedge(base)).toBe(true);
	});

	it("does not fire before the grace elapses", () => {
		expect(
			shouldForceFinalizeCrossAppWedge({
				...base,
				stopRequestedAt: new Date(now - graceMs + 1),
			}),
		).toBe(false);
	});

	it("does not fire when no stop was requested", () => {
		expect(shouldForceFinalizeCrossAppWedge({ ...base, stopRequestedAt: null })).toBe(false);
	});

	it("GAP-1: does not fire when the parent moved on to a later non-agent node", () => {
		// currentNode is a later node, not the terminated durable/run node.
		expect(
			shouldForceFinalizeCrossAppWedge({ ...base, parentCurrentNode: "browser_validate_capture" }),
		).toBe(false);
	});

	it("GAP-2: does not fire while a still-booting child has no terminated node", () => {
		// Booting sandbox 404s but its session is not DB-terminated → node not listed.
		expect(shouldForceFinalizeCrossAppWedge({ ...base, terminatedChildNodes: [] })).toBe(false);
	});

	it("does not fire when the parent's current node is unknown (null)", () => {
		expect(shouldForceFinalizeCrossAppWedge({ ...base, parentCurrentNode: null })).toBe(false);
	});

	it("GAP-3: fires for a for/loop node whose loop-nested durable/run children are terminated", () => {
		// GAN harness: parent currentNodeId is the bare loop name `refine`; its
		// durable/run children dispatch as `refine-generate-0-` / `refine-evaluate-0-`,
		// so an exact match never hit and the parent wedged RUNNING.
		expect(
			shouldForceFinalizeCrossAppWedge({
				...base,
				parentCurrentNode: "refine",
				terminatedChildNodes: ["refine-generate-0-", "refine-evaluate-0-"],
				activeChildNodes: [],
			}),
		).toBe(true);
	});

	it("GAP-3: does NOT fire while a loop iteration is still active under the parent", () => {
		expect(
			shouldForceFinalizeCrossAppWedge({
				...base,
				parentCurrentNode: "refine",
				terminatedChildNodes: ["refine-generate-0-"],
				activeChildNodes: ["refine-generate-1-"],
			}),
		).toBe(false);
	});

	it("does not loop-prefix-match an unrelated sibling node", () => {
		// `refine` must not match a sibling like `refine_summary` (no `-`/`/` boundary).
		expect(
			shouldForceFinalizeCrossAppWedge({
				...base,
				parentCurrentNode: "refine",
				terminatedChildNodes: ["refine_summary"],
				activeChildNodes: [],
			}),
		).toBe(false);
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

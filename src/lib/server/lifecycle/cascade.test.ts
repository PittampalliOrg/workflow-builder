import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	type DurableCascadeDeps,
	daprStateKeyMatchPattern,
	dedupeAgentRuntimeTargets,
	durableRuntimeStatusFromBody,
	isBenignDaprPurgeMiss,
	isBenignDaprTerminationMiss,
	isTerminalDurableRuntimeStatus,
	runDurableCascade,
	runWithConcurrency,
	shouldForceFinalizeCrossAppWedge,
} from "./cascade";

function makeDeps(
  overrides: Partial<DurableCascadeDeps> = {},
): DurableCascadeDeps {
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
	it("keeps the cascade engine free of infrastructure imports", () => {
		const source = readFileSync(
			join(process.cwd(), "src/lib/server/lifecycle/cascade.ts"),
			"utf8",
		);

		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("$lib/server/dapr-client");
		expect(source).not.toContain("drizzle-orm");
	});

	it("isTerminalDurableRuntimeStatus matches terminal states case-insensitively", () => {
    for (const s of [
      "COMPLETED",
      "failed",
      "Terminated",
      "CANCELLED",
      "canceled",
    ]) {
			expect(isTerminalDurableRuntimeStatus(s)).toBe(true);
		}
		for (const s of ["RUNNING", "PENDING", "SUSPENDED", "", null, undefined]) {
			expect(isTerminalDurableRuntimeStatus(s)).toBe(false);
		}
	});

	it("classifies a missing actor address only as a purge miss", () => {
		const exact =
			"rpc error: code = FailedPrecondition desc = did not find address for actor workflow-1";
		expect(isBenignDaprPurgeMiss(exact)).toBe(true);
		expect(isBenignDaprTerminationMiss(exact)).toBe(false);
		expect(
			isBenignDaprPurgeMiss(
				"did not find address for actor workflow-1",
			),
		).toBe(false);
	});

	it("durableRuntimeStatusFromBody unwraps nested status shapes", () => {
    expect(durableRuntimeStatusFromBody({ runtimeStatus: "RUNNING" })).toBe(
      "RUNNING",
		);
    expect(durableRuntimeStatusFromBody({ runtime_status: "FAILED" })).toBe(
      "FAILED",
    );
    expect(
      durableRuntimeStatusFromBody({ status: { runtimeStatus: "COMPLETED" } }),
    ).toBe("COMPLETED");
		expect(durableRuntimeStatusFromBody(null)).toBeNull();
	});

	it("dedupeAgentRuntimeTargets drops blanks + duplicates", () => {
		expect(
			dedupeAgentRuntimeTargets([
				{ runtimeAppId: "a", instanceId: "1" },
        {
          runtimeAppId: "a",
          instanceId: "1",
          runtimeSandboxName: "agent-host-a",
        },
				{ runtimeAppId: " ", instanceId: "1" },
				{ runtimeAppId: "a", instanceId: "2" },
			]),
		).toEqual([
      {
        runtimeAppId: "a",
        instanceId: "1",
        runtimeSandboxName: "agent-host-a",
      },
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
    expect(
      matches(
        "workflow-orchestrator||dapr.internal.x.workflow||sw-x-exec-ABC||history-15",
        id,
      ),
    ).toBe(true);
    expect(
      matches(
        "workflow-orchestrator||dapr.internal.x.workflow||sw-x-exec-ABC",
        id,
      ),
    ).toBe(true);
	});

	it("matches __turn__ sub-instances of a run instance", () => {
		const id = "sw-x-exec-ABC__durable__node__run__0";
    expect(
      matches(
        "agent-session-1||x.workflow||sw-x-exec-ABC__durable__node__run__0__turn__1||history-2",
        id,
      ),
    ).toBe(true);
	});

	it("matches agent_py_state _workflow_ keys (lowercased id)", () => {
		const id = "sw-x-exec-ABC__durable__node__run__0";
    expect(
      matches(
        "dapr-agent-py||dapr-agent-py:_workflow_sw-x-exec-abc__durable__node__run__0",
        id,
      ),
    ).toBe(true);
	});

	it("does NOT match a sibling whose index is a prefix superset", () => {
		const id = "sw-x-exec-ABC__durable__node__run__1";
    expect(
      matches(
        "agent-session-1||x.workflow||sw-x-exec-ABC__durable__node__run__10__turn__1||history-2",
        id,
      ),
    ).toBe(false);
    expect(
      matches(
        "agent-session-1||x.workflow||sw-x-exec-ABC__durable__node__run__11",
        id,
      ),
    ).toBe(false);
	});

	it("does NOT match a different instance", () => {
    expect(
      matches(
        "workflow-orchestrator||x.workflow||sw-x-exec-XYZ||history-1",
        "sw-x-exec-ABC",
      ),
    ).toBe(false);
	});
});

describe("shouldForceFinalizeCrossAppWedge", () => {
	const now = 1_000_000;
	const graceMs = 180_000;
	// Positive evidence: a durable/run child node is DB-terminal and no child is
	// still active anywhere. `parentCurrentNode` no longer gates the decision (it is
	// diagnostic-only) — the child-evidence rule + the grace do.
	const base = {
		stopRequestedAt: new Date(now - graceMs - 1),
		nowMs: now,
		graceMs,
		parentCurrentNode: "build_3b1b_animation",
		terminatedChildNodes: ["build_3b1b_animation"],
		activeChildNodes: [] as string[],
	};

	// --- Grace / stop-intent gating (unchanged) --------------------------------

	it("fires: a terminated durable/run child, no active child, grace elapsed", () => {
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
    expect(
      shouldForceFinalizeCrossAppWedge({ ...base, stopRequestedAt: null }),
    ).toBe(false);
	});

	// --- Core child-evidence matrix (the fix) ----------------------------------

	it("(a) fires when currentNodeId still MATCHES the terminated child's node", () => {
		// The classic wedge — the pre-fix behavior, kept green.
		expect(
			shouldForceFinalizeCrossAppWedge({
				...base,
				parentCurrentNode: "build_3b1b_animation",
				terminatedChildNodes: ["build_3b1b_animation"],
				activeChildNodes: [],
			}),
		).toBe(true);
	});

	it("(b) fires when currentNodeId has ADVANCED past the terminated child, no active child", () => {
		// THE FIX: `plan` durable/run child crash-finalized while the parent advanced
		// to a later approval-gate `approve_goal_spec`. currentNodeId no longer matches
		// the dead child's node, but the run is still wedged → force-finalize.
		expect(
			shouldForceFinalizeCrossAppWedge({
				...base,
				parentCurrentNode: "approve_goal_spec",
				terminatedChildNodes: ["plan"],
				activeChildNodes: [],
			}),
		).toBe(true);
	});

	it("(c) does NOT fire when a terminated child is under one node but an ACTIVE child is under another", () => {
		// A parent that crashed an earlier durable/run branch (`plan`) but is now
		// legitimately running a LATER one (`solve`) with a live child — the absolute
		// "no active child anywhere" guard protects it.
		expect(
			shouldForceFinalizeCrossAppWedge({
				...base,
				parentCurrentNode: "solve",
				terminatedChildNodes: ["plan"],
				activeChildNodes: ["solve"],
			}),
		).toBe(false);
	});

	it("(d) a crash-finalized (failed+completedAt) child node finalizes; a not-yet-completed failed one does not", () => {
		// The resolver (lifecycle-resolver.ts, PR #441) classifies a child that is
		// `failed` WITH completedAt as terminal → its node lands in terminatedChildNodes
		// → the wedge finalizes. A child that is `failed` WITHOUT completedAt is not yet
		// crash-finalized → its node stays in activeChildNodes → the guard blocks. We
		// model both resolver outputs at the predicate boundary here.
		expect(
			shouldForceFinalizeCrossAppWedge({
				...base,
				terminatedChildNodes: ["plan"],
				activeChildNodes: [],
			}),
		).toBe(true);
		expect(
			shouldForceFinalizeCrossAppWedge({
				...base,
				terminatedChildNodes: [],
				activeChildNodes: ["plan"],
			}),
		).toBe(false);
	});

	it("(e) does NOT fire when there are no terminated children at all", () => {
		// A still-booting sandbox that merely 404s has no DB-terminal child → no node
		// listed → no cross-app wedge to clean up.
		expect(
      shouldForceFinalizeCrossAppWedge({
        ...base,
        terminatedChildNodes: [],
        activeChildNodes: [],
      }),
		).toBe(false);
	});

	// --- currentNodeId is diagnostic-only: same child evidence, any node --------

	it.each([
		["matches the dead child", "build_3b1b_animation"],
		["advanced to a later node", "approve_goal_spec"],
		["is unknown (null / status unavailable)", null],
		["is a prefix-sibling of the dead node", "build_3b1b_animation_summary"],
	])(
		"decides on child evidence regardless of currentNodeId (%s)",
		(_label, node) => {
			// Given the SAME positive evidence (a terminated child, no active child), the
			// outcome is identical no matter what the parent's live currentNodeId is —
			// the whole point of the fix. Before it, a null/advanced/sibling node blocked
			// finalization and the Stop polled "stopping" forever.
			expect(
				shouldForceFinalizeCrossAppWedge({
					...base,
					parentCurrentNode: node,
					terminatedChildNodes: ["build_3b1b_animation"],
					activeChildNodes: [],
				}),
			).toBe(true);
		},
	);

	// --- Loop/for nodes: mid-iteration protection (unchanged) ------------------

	it("fires for a for/loop node whose loop-nested durable/run children are terminated", () => {
		// GAN harness: the loop `refine` dispatches durable/run children as
		// `refine-generate-0-` / `refine-evaluate-0-`; both terminal, none active → fire.
		expect(
			shouldForceFinalizeCrossAppWedge({
				...base,
				parentCurrentNode: "refine",
				terminatedChildNodes: ["refine-generate-0-", "refine-evaluate-0-"],
				activeChildNodes: [],
			}),
		).toBe(true);
	});

	it("does NOT fire while a loop iteration is still active anywhere", () => {
		expect(
			shouldForceFinalizeCrossAppWedge({
				...base,
				parentCurrentNode: "refine",
				terminatedChildNodes: ["refine-generate-0-"],
				activeChildNodes: ["refine-generate-1-"],
			}),
		).toBe(false);
	});
});

describe("runDurableCascade", () => {
	it("broadcasts root cancellation before child cancellation and every graceful wait", async () => {
		const events: string[] = [];
		let parentStatusCalls = 0;
		let agentStatusCalls = 0;
		const deps = makeDeps({
			getParentStatus: vi.fn(async () => {
				parentStatusCalls += 1;
				if (parentStatusCalls > 1) events.push("wait-parent");
				return parentStatusCalls === 1 ? "RUNNING" : "COMPLETED";
			}),
			getAgentRuntimeStatus: vi.fn(async () => {
				agentStatusCalls += 1;
				if (agentStatusCalls > 1) events.push("wait-child");
				return agentStatusCalls === 1 ? "RUNNING" : "COMPLETED";
			}),
			cancelParent: vi.fn(async () => {
				events.push("cancel-parent");
				return "requested" as const;
			}),
			cancelAgentRuntime: vi.fn(async () => {
				events.push("cancel-child");
				return "requested" as const;
			}),
		});

		await runDurableCascade({
			parentInstanceIds: ["p1"],
			agentRuntimeTargets: [{ runtimeAppId: "app", instanceId: "i1" }],
			reason: "test",
			purge: false,
			purgeGraceMs: 0,
			gracefulCancellationEnabled: true,
			gracefulCancellationWaitMs: 1,
			deps,
		});

		expect(events).toEqual([
			"cancel-parent",
			"cancel-child",
			"wait-child",
			"wait-parent",
		]);
		expect(deps.terminateAgentRuntime).not.toHaveBeenCalled();
		expect(deps.terminateParent).not.toHaveBeenCalled();
	});

	it("broadcasts both cancellations before either force terminate", async () => {
		const events: string[] = [];
		let now = 0;
		const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const deps = makeDeps({
			getParentStatus: vi.fn(async () => "RUNNING"),
			getAgentRuntimeStatus: vi.fn(async () => "RUNNING"),
			cancelParent: vi.fn(async () => {
				events.push("cancel-parent");
				return "requested" as const;
			}),
			cancelAgentRuntime: vi.fn(async () => {
				events.push("cancel-child");
				return "requested" as const;
			}),
			terminateAgentRuntime: vi.fn(async () => {
				events.push("terminate-child");
				return "terminated" as const;
			}),
			terminateParent: vi.fn(async () => {
				events.push("terminate-parent");
				return "terminated" as const;
			}),
			sleep: vi.fn(async (ms: number) => {
				now += ms;
			}),
		});

		try {
			await runDurableCascade({
				parentInstanceIds: ["p1"],
				agentRuntimeTargets: [{ runtimeAppId: "app", instanceId: "i1" }],
				reason: "test",
				purge: false,
				purgeGraceMs: 0,
				gracefulCancellationEnabled: true,
				gracefulCancellationWaitMs: 1,
				deps,
			});
		} finally {
			nowSpy.mockRestore();
			warnSpy.mockRestore();
		}

		expect(events).toEqual([
			"cancel-parent",
			"cancel-child",
			"terminate-child",
			"terminate-parent",
		]);
	});

	it("terminates then purges parent + agent runtimes when all close", async () => {
		const deps = makeDeps();
		const result = await runDurableCascade({
			parentInstanceIds: ["p1"],
      agentRuntimeTargets: [
        {
          runtimeAppId: "app",
          instanceId: "i1",
          runtimeSandboxName: "agent-host-app",
        },
      ],
			reason: "test",
			purge: true,
			purgeGraceMs: 0,
			deps,
		});
		expect(result.allClosed).toBe(true);
		expect(deps.terminateParent).toHaveBeenCalledWith("p1", "test");
    expect(deps.terminateAgentRuntime).toHaveBeenCalledWith(
      "app",
      "i1",
      "test",
      "agent-host-app",
    );
		expect(deps.purgeParent).toHaveBeenCalledWith("p1");
    expect(deps.purgeAgentRuntime).toHaveBeenCalledWith(
      "app",
      "i1",
      "agent-host-app",
    );
		expect(deps.purgeStateRows).toHaveBeenCalledTimes(1);
	});

	it("continues from a missing parent actor to mandatory state-row purge only with caller proof", async () => {
		const actorMiss = new Error(
			"Failed to purge workflow p1: rpc error: code = FailedPrecondition desc = did not find address for actor p1",
		);
		const blockedDeps = makeDeps({
			getParentStatus: vi.fn(async () => "TERMINATED"),
			getAgentRuntimeStatus: vi.fn(async () => "COMPLETED"),
			purgeParent: vi.fn(async () => {
				throw actorMiss;
			}),
		});

		await expect(
			runDurableCascade({
				parentInstanceIds: ["p1"],
				agentRuntimeTargets: [{ runtimeAppId: "app", instanceId: "i1" }],
				reason: "test",
				purge: true,
				purgeGraceMs: 0,
				deps: blockedDeps,
			}),
		).rejects.toThrow("did not find address for actor");
		expect(blockedDeps.purgeStateRows).not.toHaveBeenCalled();

		const provenDeps = makeDeps({
			getParentStatus: vi.fn(async () => "TERMINATED"),
			getAgentRuntimeStatus: vi.fn(async () => "COMPLETED"),
			purgeParent: vi.fn(async () => {
				throw actorMiss;
			}),
			purgeStateRows: vi.fn(async () => {}),
		});
		await expect(
			runDurableCascade({
				parentInstanceIds: ["p1"],
				agentRuntimeTargets: [{ runtimeAppId: "app", instanceId: "i1" }],
				reason: "test",
				purge: true,
				purgeGraceMs: 0,
				allowMissingParentActorPurge: true,
				deps: provenDeps,
			}),
		).resolves.toMatchObject({ allClosed: true });
		expect(provenDeps.purgeStateRows).toHaveBeenCalledOnce();
		expect(
			vi.mocked(provenDeps.purgeParent).mock.invocationCallOrder[0],
		).toBeLessThan(
			vi.mocked(provenDeps.purgeStateRows!).mock.invocationCallOrder[0],
		);
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

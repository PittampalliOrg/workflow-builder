/**
 * deliverTeamMessages state machine, with every side effect behind injected
 * deps. Pins ownership + mailbox claim before host probing, the wake ordering,
 * retry/drop outcomes, and the lease/accept/complete crash windows.
 */

import { describe, expect, it, vi } from "vitest";
import type { TeamStore } from "$lib/server/application/ports";
import {
	deliverTeamMessages,
  teamMailboxBatchId,
	type TeamDeliveryDeps,
} from "$lib/server/teams/team-delivery";

type SessionState = {
		status: string;
  stopRequested?: boolean;
		daprInstanceId: string | null;
		runtimeAppId: string | null;
		runtimeSandboxName: string | null;
  runtimeDesiredRunning?: boolean;
};

type Overrides = {
  session?: SessionState | null;
	pod?: { presence: "present" | "absent" | "unknown"; exited: boolean };
	cr?: { spec?: Record<string, unknown> } | null;
  claimed?: Array<{
    id: string;
    sequence: number;
    data: Record<string, unknown>;
  }>;
  sessionStates?: Array<SessionState | null>;
  transitioned?: boolean;
  verifyStates?: boolean[];
  operationBusy?: boolean;
  memberMissing?: boolean;
  claimToken?: string;
  completedCount?: number;
	unprocessed?: boolean;
  ensureRuntimeHost?: (input: {
    sessionId: string;
    runtimeAppId: string;
    runtimeSandboxName: string;
  }) => Promise<{ recovered: boolean }>;
};

function makeDeps(o: Overrides = {}) {
	const calls: string[] = [];
	const session =
		o.session === undefined
			? {
					status: "idle",
          stopRequested: false,
					daprInstanceId: "sess-1",
					runtimeAppId: "agent-session-abc",
					runtimeSandboxName: "agent-host-agent-session-abc",
				}
			: o.session;
	const store = {
    claimRuntimeOperation: vi.fn(async () => {
      calls.push("claimRuntime");
      if (
        o.operationBusy ||
        !session ||
        session.stopRequested ||
        ["terminated", "completed", "failed", "error"].includes(
          session.status,
        ) ||
        !session.daprInstanceId
      ) {
        return null;
      }
      return {
        operationId: "delivery-op-1",
        operation: "delivery" as const,
        desiredRunning: true,
        startedAt: new Date().toISOString(),
        memberStatus: "idle",
        daprInstanceId: session.daprInstanceId,
        runtimeAppId: session.runtimeAppId,
        runtimeSandboxName: session.runtimeSandboxName,
      };
    }),
    verifyRuntimeOperation: vi.fn(async () => {
      calls.push("verifyRuntime");
      return o.verifyStates?.length ? o.verifyStates.shift()! : true;
    }),
    finishRuntimeOperation: vi.fn(async () => {
      calls.push("finishRuntime");
      return o.transitioned ?? true;
    }),
		getMemberBySession: vi.fn(async () =>
      o.memberMissing ? null : { id: "member-1" },
    ),
    getSessionDeliveryState: vi.fn(async () =>
      o.sessionStates?.length ? o.sessionStates.shift() : session,
		),
	} as unknown as TeamStore;
	const deps: TeamDeliveryDeps = {
		store,
    runtimeHost: {
      getPodStatus: vi.fn(async () => {
			calls.push("podStatus");
			return o.pod ?? { presence: "present" as const, exited: false };
		}),
      deleteExitedPods: vi.fn(async () => {
			calls.push("deleteExited");
			return [];
		}),
      getSandboxState: vi.fn(async () => {
			calls.push("getSandbox");
        if (o.cr === null) return { presence: "absent" as const };
        const replicas = o.cr?.spec?.replicas;
        return {
          presence: "present" as const,
          desiredRunning: typeof replicas === "number" ? replicas >= 1 : false,
        };
      }),
      resume: vi.fn(async () => {
			calls.push("resume");
			return "patched" as const;
		}),
      suspend: vi.fn(async () => "patched" as const),
      waitUntilReady: vi.fn(async () => {
			calls.push("waitReady");
		}),
    },
		claimUnraisedTeamEvents: vi.fn(async () => {
			calls.push("claim");
			return (
				o.claimed ?? [
					{ id: "e1", sequence: 1, data: { type: "user.message" } },
					{ id: "e2", sequence: 2, data: { type: "user.message" } },
				]
			);
		}),
	hasUnprocessedTeamEvents: vi.fn(async () => {
		calls.push("hasPending");
		return o.unprocessed ?? (o.claimed ? o.claimed.length > 0 : true);
	}),
    completeTeamEventDelivery: vi.fn(async () => {
      calls.push("complete");
      return o.completedCount ?? (o.claimed?.length ?? 2);
		}),
    releaseTeamEventDeliveryClaim: vi.fn(async () => {
      calls.push("releaseClaim");
      return o.claimed?.length ?? 2;
    }),
    newClaimToken: () => o.claimToken ?? "claim-token-1",
    ensurePublishedRuntimeHost: vi.fn(async (input) => {
      calls.push("ensureRuntime");
      return o.ensureRuntimeHost
        ? o.ensureRuntimeHost(input)
        : { recovered: true };
    }),
    raiseSessionUserEvents: vi.fn(async (_sessionId, _events, delivery) => {
			calls.push("raise");
      return { accepted: true as const, deliveryId: delivery.batchId };
		}),
		appendSessionEvent: vi.fn(async () => {
			calls.push("audit");
			return {};
		}),
	};
	return { deps, calls, store };
}

describe("deliverTeamMessages", () => {
	it("live pod: no kube mutations, claim → raise → member working + audit", async () => {
		const { deps, calls } = makeDeps();
		const outcome = await deliverTeamMessages("sess-1", deps);
		expect(outcome).toBe("delivered");
    expect(calls).toEqual([
      "claimRuntime",
      "claim",
      "verifyRuntime",
      "podStatus",
      "verifyRuntime",
      "raise",
      "complete",
      "finishRuntime",
      "audit",
		]);
    expect(deps.raiseSessionUserEvents).toHaveBeenCalledWith(
      "sess-1",
      [{ type: "user.message" }, { type: "user.message" }],
      {
        kind: "team-mailbox",
        batchId: teamMailboxBatchId("sess-1", ["e1", "e2"]),
        eventIds: ["e1", "e2"],
      },
    );
    expect(deps.claimUnraisedTeamEvents).toHaveBeenCalledWith({
      sessionId: "sess-1",
      claimToken: "claim-token-1",
      staleAfterSeconds: 300,
    });
    expect(deps.completeTeamEventDelivery).toHaveBeenCalledWith({
      sessionId: "sess-1",
      claimToken: "claim-token-1",
    });
	});

	it("suspended (pod absent): converge → resume → wait → claim → raise, in order", async () => {
    const { deps, calls } = makeDeps({
      pod: { presence: "absent", exited: false },
    });
		const outcome = await deliverTeamMessages("sess-1", deps);
		expect(outcome).toBe("delivered");
		expect(calls).toEqual([
      "claimRuntime",
      "claim",
      "verifyRuntime",
			"podStatus",
			"getSandbox",
      "verifyRuntime",
			"resume",
			"waitReady",
      "verifyRuntime",
      "raise",
      "complete",
      "finishRuntime",
      "audit",
    ]);
    expect(deps.runtimeHost.deleteExitedPods).not.toHaveBeenCalled();
  });

  it("recovers an absent published Sandbox before raising the exact mailbox batch", async () => {
    const { deps, calls } = makeDeps({
      pod: { presence: "absent", exited: false },
      cr: null,
    });

    expect(await deliverTeamMessages("sess-1", deps)).toBe("delivered");
    expect(deps.ensurePublishedRuntimeHost).toHaveBeenCalledWith({
      sessionId: "sess-1",
      runtimeAppId: "agent-session-abc",
      runtimeSandboxName: "agent-host-agent-session-abc",
    });
    expect(calls).toEqual([
      "claimRuntime",
			"claim",
      "verifyRuntime",
      "podStatus",
      "getSandbox",
      "verifyRuntime",
      "ensureRuntime",
      "verifyRuntime",
      "waitReady",
      "verifyRuntime",
			"raise",
      "complete",
      "finishRuntime",
			"audit",
		]);
  });

  it("releases the exact claim and retries when absent-host recovery is unavailable", async () => {
    const { deps } = makeDeps({
      pod: { presence: "absent", exited: false },
      cr: null,
      ensureRuntimeHost: async () => {
        throw new Error("provider unavailable");
      },
    });

    expect(await deliverTeamMessages("sess-1", deps)).toBe("retry");
    expect(deps.releaseTeamEventDeliveryClaim).toHaveBeenCalledWith({
      sessionId: "sess-1",
      claimToken: "claim-token-1",
    });
    expect(deps.raiseSessionUserEvents).not.toHaveBeenCalled();
  });

  it("drops without raising when stop wins during absent-host recovery", async () => {
    const active = {
      status: "idle",
      stopRequested: false,
      daprInstanceId: "wf-1",
      runtimeAppId: "agent-session-abc",
      runtimeSandboxName: "agent-host-agent-session-abc",
    };
    const { deps } = makeDeps({
      pod: { presence: "absent", exited: false },
      cr: null,
      verifyStates: [true, true, false],
      sessionStates: [{ ...active, stopRequested: true }],
    });

    expect(await deliverTeamMessages("sess-1", deps)).toBe("drop");
    expect(deps.ensurePublishedRuntimeHost).toHaveBeenCalledOnce();
    expect(deps.releaseTeamEventDeliveryClaim).toHaveBeenCalled();
    expect(deps.raiseSessionUserEvents).not.toHaveBeenCalled();
	});

	it("exited pod with replicas still 1: deletes the exited pod, skips the patch", async () => {
		const { deps, calls } = makeDeps({
			pod: { presence: "present", exited: true },
			cr: { spec: { replicas: 1 } },
		});
		const outcome = await deliverTeamMessages("sess-1", deps);
		expect(outcome).toBe("delivered");
		expect(calls).toContain("deleteExited");
    expect(deps.runtimeHost.resume).not.toHaveBeenCalled();
	});

  it("readiness timeout: releases the mailbox and operation leases for retry", async () => {
		const { deps } = makeDeps({ pod: { presence: "absent", exited: false } });
    vi.mocked(deps.runtimeHost.waitUntilReady).mockRejectedValueOnce(
			new Error("not ready"),
		);
		expect(await deliverTeamMessages("sess-1", deps)).toBe("retry");
    expect(deps.claimUnraisedTeamEvents).toHaveBeenCalledOnce();
    expect(deps.releaseTeamEventDeliveryClaim).toHaveBeenCalled();
	});

  it("raise failure: releases only the exact claim token and retries", async () => {
		const { deps } = makeDeps();
		vi.mocked(deps.raiseSessionUserEvents).mockRejectedValueOnce(
			new Error("raise failed"),
		);
		expect(await deliverTeamMessages("sess-1", deps)).toBe("retry");
    expect(deps.releaseTeamEventDeliveryClaim).toHaveBeenCalledWith({
      sessionId: "sess-1",
      claimToken: "claim-token-1",
    });
    expect(deps.appendSessionEvent).not.toHaveBeenCalled();
  });

  it("leaves an accepted claim leased when DB completion crashes", async () => {
    const { deps } = makeDeps();
    vi.mocked(deps.completeTeamEventDelivery).mockRejectedValueOnce(
      new Error("database connection lost after runtime acceptance"),
    );

    expect(await deliverTeamMessages("sess-1", deps)).toBe("retry");
    expect(
      vi.mocked(deps.raiseSessionUserEvents).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(deps.completeTeamEventDelivery).mock.invocationCallOrder[0],
    );
    expect(deps.releaseTeamEventDeliveryClaim).not.toHaveBeenCalled();
    expect(deps.appendSessionEvent).not.toHaveBeenCalled();
  });

  it("retries without releasing when exact-token completion lost its lease", async () => {
    const { deps } = makeDeps({ completedCount: 0 });

    expect(await deliverTeamMessages("sess-1", deps)).toBe("retry");
    expect(deps.releaseTeamEventDeliveryClaim).not.toHaveBeenCalled();
		expect(deps.appendSessionEvent).not.toHaveBeenCalled();
	});

  it("derives the same receiver receipt across claim-token retries", () => {
    expect(teamMailboxBatchId("sess-1", ["e1", "e2"])).toBe(
      teamMailboxBatchId("sess-1", ["e1", "e2"]),
    );
    expect(teamMailboxBatchId("sess-1", ["e1", "e2"])).not.toBe(
      teamMailboxBatchId("sess-1", ["e1", "e3"]),
    );
  });

	it("truly empty mailbox is delivered without raising", async () => {
		const { deps } = makeDeps({ claimed: [] });
		expect(await deliverTeamMessages("sess-1", deps)).toBe("delivered");
		expect(deps.hasUnprocessedTeamEvents).toHaveBeenCalledWith("sess-1");
		expect(deps.raiseSessionUserEvents).not.toHaveBeenCalled();
	});

	it("stale runtime takeover retries while a fresher mailbox claim is pending", async () => {
		const { deps } = makeDeps({ claimed: [], unprocessed: true });

		expect(await deliverTeamMessages("sess-1", deps)).toBe("retry");
		expect(deps.hasUnprocessedTeamEvents).toHaveBeenCalledWith("sess-1");
		expect(deps.raiseSessionUserEvents).not.toHaveBeenCalled();
	});

	it("ambiguous committed claim response releases exactly and never ACKs pending rows", async () => {
		const { deps } = makeDeps({ claimed: [], unprocessed: true });
		vi.mocked(deps.claimUnraisedTeamEvents)
			.mockRejectedValueOnce(new Error("response lost after commit"))
			.mockResolvedValueOnce([]);

		expect(await deliverTeamMessages("sess-1", deps)).toBe("retry");
		expect(deps.releaseTeamEventDeliveryClaim).toHaveBeenCalledWith({
			sessionId: "sess-1",
			claimToken: "claim-token-1",
		});
		expect(await deliverTeamMessages("sess-1", deps)).toBe("retry");
		expect(deps.hasUnprocessedTeamEvents).toHaveBeenCalledWith("sess-1");
		expect(deps.raiseSessionUserEvents).not.toHaveBeenCalled();
	});

  it("drop cases: missing session / terminal / unspawned", async () => {
    expect(
      await deliverTeamMessages("s", makeDeps({ session: null }).deps),
    ).toBe("drop");
		expect(
			await deliverTeamMessages(
				"s",
				makeDeps({
					session: {
						status: "terminated",
						daprInstanceId: "x",
						runtimeAppId: null,
						runtimeSandboxName: null,
					},
				}).deps,
			),
		).toBe("drop");
		expect(
			await deliverTeamMessages(
				"s",
				makeDeps({
					session: {
						status: "rescheduling",
            daprInstanceId: null, // runtime publication re-drives the mailbox
						runtimeAppId: null,
						runtimeSandboxName: null,
					},
				}).deps,
			),
		).toBe("drop");
  });

  it("does not wake or deliver to a session with persisted stop intent", async () => {
    const { deps } = makeDeps({
      session: {
        status: "idle",
        stopRequested: true,
        daprInstanceId: "wf-1",
        runtimeAppId: "agent-session-abc",
        runtimeSandboxName: "agent-host-agent-session-abc",
      },
    });

    expect(await deliverTeamMessages("sess-1", deps)).toBe("drop");
    expect(deps.runtimeHost.getPodStatus).not.toHaveBeenCalled();
	});

	it("unknown pod presence (API blip): retry without mutations", async () => {
		const { deps } = makeDeps({ pod: { presence: "unknown", exited: false } });
		expect(await deliverTeamMessages("sess-1", deps)).toBe("retry");
    expect(deps.runtimeHost.getSandboxState).not.toHaveBeenCalled();
    expect(deps.claimUnraisedTeamEvents).toHaveBeenCalledOnce();
    expect(deps.releaseTeamEventDeliveryClaim).toHaveBeenCalled();
	});

  it("does not append a wake audit when the conditional member transition loses", async () => {
    const { deps, store } = makeDeps({ transitioned: false });
		expect(await deliverTeamMessages("sess-1", deps)).toBe("delivered");
		expect(
      (
        store as unknown as {
          finishRuntimeOperation: ReturnType<typeof vi.fn>;
        }
      ).finishRuntimeOperation,
    ).toHaveBeenCalled();
    expect(deps.appendSessionEvent).not.toHaveBeenCalled();
  });

  it("leaves a raced wake running for lifecycle but claims no messages", async () => {
    const active = {
      status: "idle",
      stopRequested: false,
      daprInstanceId: "wf-1",
      runtimeAppId: "agent-session-abc",
      runtimeSandboxName: "agent-host-agent-session-abc",
    };
    const { deps } = makeDeps({
      pod: { presence: "absent", exited: false },
      verifyStates: [true, true, false],
      sessionStates: [{ ...active, stopRequested: true }],
    });

    expect(await deliverTeamMessages("sess-1", deps)).toBe("drop");
    expect(deps.runtimeHost.resume).toHaveBeenCalled();
    expect(deps.runtimeHost.suspend).not.toHaveBeenCalled();
    expect(deps.claimUnraisedTeamEvents).toHaveBeenCalledOnce();
    expect(deps.releaseTeamEventDeliveryClaim).toHaveBeenCalled();
  });

  it("releases without raising when stop intent wins after the mailbox claim", async () => {
    const active = {
      status: "idle",
      stopRequested: false,
      daprInstanceId: "wf-1",
      runtimeAppId: "agent-session-abc",
      runtimeSandboxName: "agent-host-agent-session-abc",
    };
    const { deps } = makeDeps({
      verifyStates: [false],
      sessionStates: [{ ...active, stopRequested: true }],
    });

    expect(await deliverTeamMessages("sess-1", deps)).toBe("drop");
    expect(deps.releaseTeamEventDeliveryClaim).toHaveBeenCalledWith({
      sessionId: "sess-1",
      claimToken: "claim-token-1",
    });
    expect(deps.raiseSessionUserEvents).not.toHaveBeenCalled();
	});
});

/**
 * deliverTeamMessages state machine, with every side effect behind injected
 * deps. Pins the wake ordering (converge-exited → resume → ready-wait →
 * claim → raise), the retry/drop outcomes, and the claim/unclaim dedup dance.
 */

import { describe, expect, it, vi } from "vitest";
import type { TeamStore } from "$lib/server/application/ports";
import {
	deliverTeamMessages,
	type TeamDeliveryDeps,
} from "$lib/server/teams/team-delivery";

type Overrides = {
	session?: {
		status: string;
		daprInstanceId: string | null;
		runtimeAppId: string | null;
		runtimeSandboxName: string | null;
	} | null;
	pod?: { presence: "present" | "absent" | "unknown"; exited: boolean };
	cr?: { spec?: Record<string, unknown> } | null;
	claimed?: Array<{ id: string; sequence: number; data: Record<string, unknown> }>;
	member?: { role: string } | null;
};

function makeDeps(o: Overrides = {}) {
	const calls: string[] = [];
	const session =
		o.session === undefined
			? {
					status: "idle",
					daprInstanceId: "sess-1",
					runtimeAppId: "agent-session-abc",
					runtimeSandboxName: "agent-host-agent-session-abc",
				}
			: o.session;
	const store = {
		getSessionDeliveryState: vi.fn(async () => session),
		getMemberBySession: vi.fn(async () =>
			o.member === undefined
				? { role: "member", session_id: "sess-1" }
				: o.member,
		),
		setMemberStatus: vi.fn(async () => {
			calls.push("setMemberStatus");
		}),
	} as unknown as TeamStore;
	const deps: TeamDeliveryDeps = {
		store,
		getSessionRuntimePodStatus: vi.fn(async () => {
			calls.push("podStatus");
			return o.pod ?? { presence: "present" as const, exited: false };
		}),
		deleteSessionRuntimeExitedPods: vi.fn(async () => {
			calls.push("deleteExited");
			return [];
		}),
		getKubernetesSandbox: vi.fn(async () => {
			calls.push("getSandbox");
			return o.cr === undefined ? { spec: { replicas: 0 } } : o.cr;
		}) as never,
		resumeSessionSandbox: vi.fn(async () => {
			calls.push("resume");
			return "patched" as const;
		}),
		waitForAgentWorkflowHostAppReady: vi.fn(async () => {
			calls.push("waitReady");
			return {};
		}),
		claimUnraisedTeamEvents: vi.fn(async () => {
			calls.push("claim");
			return (
				o.claimed ?? [
					{ id: "e1", sequence: 1, data: { type: "user.message" } },
					{ id: "e2", sequence: 2, data: { type: "user.message" } },
				]
			);
		}),
		unclaimSessionEvents: vi.fn(async () => {
			calls.push("unclaim");
		}),
		raiseSessionUserEvents: vi.fn(async () => {
			calls.push("raise");
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
		expect(calls).toEqual(["podStatus", "claim", "raise", "setMemberStatus", "audit"]);
		expect(deps.raiseSessionUserEvents).toHaveBeenCalledWith("sess-1", [
			{ type: "user.message" },
			{ type: "user.message" },
		]);
	});

	it("suspended (pod absent): converge → resume → wait → claim → raise, in order", async () => {
		const { deps, calls } = makeDeps({ pod: { presence: "absent", exited: false } });
		const outcome = await deliverTeamMessages("sess-1", deps);
		expect(outcome).toBe("delivered");
		expect(calls).toEqual([
			"podStatus",
			"getSandbox",
			"resume",
			"waitReady",
			"claim",
			"raise",
			"setMemberStatus",
			"audit",
		]);
		expect(deps.deleteSessionRuntimeExitedPods).not.toHaveBeenCalled();
	});

	it("exited pod with replicas still 1: deletes the exited pod, skips the patch", async () => {
		const { deps, calls } = makeDeps({
			pod: { presence: "present", exited: true },
			cr: { spec: { replicas: 1 } },
		});
		const outcome = await deliverTeamMessages("sess-1", deps);
		expect(outcome).toBe("delivered");
		expect(calls).toContain("deleteExited");
		expect(deps.resumeSessionSandbox).not.toHaveBeenCalled();
	});

	it("readiness timeout: retry, with NOTHING claimed", async () => {
		const { deps } = makeDeps({ pod: { presence: "absent", exited: false } });
		vi.mocked(deps.waitForAgentWorkflowHostAppReady).mockRejectedValueOnce(
			new Error("not ready"),
		);
		expect(await deliverTeamMessages("sess-1", deps)).toBe("retry");
		expect(deps.claimUnraisedTeamEvents).not.toHaveBeenCalled();
	});

	it("raise failure: unclaims the exact ids and retries", async () => {
		const { deps } = makeDeps();
		vi.mocked(deps.raiseSessionUserEvents).mockRejectedValueOnce(
			new Error("raise failed"),
		);
		expect(await deliverTeamMessages("sess-1", deps)).toBe("retry");
		expect(deps.unclaimSessionEvents).toHaveBeenCalledWith("sess-1", ["e1", "e2"]);
		expect(deps.appendSessionEvent).not.toHaveBeenCalled();
	});

	it("empty claim (raced delivery): delivered without raising", async () => {
		const { deps } = makeDeps({ claimed: [] });
		expect(await deliverTeamMessages("sess-1", deps)).toBe("delivered");
		expect(deps.raiseSessionUserEvents).not.toHaveBeenCalled();
	});

	it("drop cases: missing session / terminal / unspawned / CR gone", async () => {
		expect(await deliverTeamMessages("s", makeDeps({ session: null }).deps)).toBe("drop");
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
						daprInstanceId: null, // never spawned — initialEvents path
						runtimeAppId: null,
						runtimeSandboxName: null,
					},
				}).deps,
			),
		).toBe("drop");
		const gone = makeDeps({ pod: { presence: "absent", exited: false }, cr: null });
		expect(await deliverTeamMessages("s", gone.deps)).toBe("drop");
	});

	it("unknown pod presence (API blip): retry without mutations", async () => {
		const { deps } = makeDeps({ pod: { presence: "unknown", exited: false } });
		expect(await deliverTeamMessages("sess-1", deps)).toBe("retry");
		expect(deps.getKubernetesSandbox).not.toHaveBeenCalled();
		expect(deps.claimUnraisedTeamEvents).not.toHaveBeenCalled();
	});

	it("does not flip the lead's member status", async () => {
		const { deps, store } = makeDeps({ member: { role: "lead" } });
		expect(await deliverTeamMessages("sess-1", deps)).toBe("delivered");
		expect(
			(store as unknown as { setMemberStatus: ReturnType<typeof vi.fn> })
				.setMemberStatus,
		).not.toHaveBeenCalled();
	});
});

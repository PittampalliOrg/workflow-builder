import { describe, expect, it, vi } from "vitest";
import { applyPauseResume, type PauseResumeDeps } from "./pause";
import type { ResolvedDurableTarget } from "./resolvers";

const SESSION = { kind: "session" as const, id: "sess-1" };
const SCOPE = { projectId: "p1", userId: "u1" };
const RUNTIME = { runtimeAppId: "agent-session-abc", instanceId: "sess-1" };

function resolved(partial: Partial<ResolvedDurableTarget>): ResolvedDurableTarget {
	return {
		notFound: false,
		dbActive: true,
		scope: SCOPE,
		agentRuntimeTargets: [RUNTIME],
		...partial,
	} as unknown as ResolvedDurableTarget;
}

function makeDeps(over: Partial<PauseResumeDeps> = {}): PauseResumeDeps {
	return {
		resolve: async () => resolved({}),
		invoke: vi.fn(async () => true),
		setSessionStatus: vi.fn(async () => {}),
		...over,
	};
}

describe("applyPauseResume — pause", () => {
	it("suspends the runtime (verb=pause) and mirrors status='paused' + a timestamp", async () => {
		const invoke = vi.fn(async () => true);
		const setSessionStatus = vi.fn(async () => {});
		const r = await applyPauseResume(SESSION, "pause", makeDeps({ invoke, setSessionStatus }));
		expect(r.ok).toBe(true);
		expect(invoke).toHaveBeenCalledWith(RUNTIME, "pause");
		expect(setSessionStatus).toHaveBeenCalledWith("sess-1", "paused", expect.any(Date));
	});

	it("returns notFound when the target doesn't resolve", async () => {
		const r = await applyPauseResume(
			SESSION,
			"pause",
			makeDeps({ resolve: async () => resolved({ notFound: true }) }),
		);
		expect(r.ok).toBe(false);
		expect(r.notFound).toBe(true);
	});

	it("refuses to pause a terminated/inactive run (not_active) and does not touch the DB", async () => {
		const setSessionStatus = vi.fn(async () => {});
		const r = await applyPauseResume(
			SESSION,
			"pause",
			makeDeps({ resolve: async () => resolved({ dbActive: false }), setSessionStatus }),
		);
		expect(r.ok).toBe(false);
		expect(r.reason).toBe("not_active");
		expect(setSessionStatus).not.toHaveBeenCalled();
	});

	it("returns no_runtime when there is no runtime target", async () => {
		const r = await applyPauseResume(
			SESSION,
			"pause",
			makeDeps({ resolve: async () => resolved({ agentRuntimeTargets: [] }) }),
		);
		expect(r.ok).toBe(false);
		expect(r.reason).toBe("no_runtime");
	});

	it("returns suspend_failed (and no DB write) when every runtime invoke fails", async () => {
		const setSessionStatus = vi.fn(async () => {});
		const r = await applyPauseResume(
			SESSION,
			"pause",
			makeDeps({ invoke: vi.fn(async () => false), setSessionStatus }),
		);
		expect(r.ok).toBe(false);
		expect(r.reason).toBe("suspend_failed");
		expect(setSessionStatus).not.toHaveBeenCalled();
	});

	it("succeeds when at least one of several runtimes confirms", async () => {
		const targets = [RUNTIME, { runtimeAppId: "agent-session-def", instanceId: "sess-1" }];
		let n = 0;
		const r = await applyPauseResume(
			SESSION,
			"pause",
			makeDeps({
				resolve: async () => resolved({ agentRuntimeTargets: targets }),
				invoke: vi.fn(async () => (n++ === 0 ? false : true)),
			}),
		);
		expect(r.ok).toBe(true);
	});
});

describe("applyPauseResume — resume", () => {
	it("resumes the runtime (verb=resume) and clears the hold (status='running', pauseRequestedAt=null)", async () => {
		const invoke = vi.fn(async () => true);
		const setSessionStatus = vi.fn(async () => {});
		const r = await applyPauseResume(SESSION, "resume", makeDeps({ invoke, setSessionStatus }));
		expect(r.ok).toBe(true);
		expect(invoke).toHaveBeenCalledWith(RUNTIME, "resume");
		expect(setSessionStatus).toHaveBeenCalledWith("sess-1", "running", null);
	});

	it("does NOT require dbActive (a paused run can resume)", async () => {
		// resume must not be gated by the pause-only not_active check.
		const r = await applyPauseResume(
			SESSION,
			"resume",
			makeDeps({ resolve: async () => resolved({ dbActive: true }) }),
		);
		expect(r.ok).toBe(true);
	});

	it("returns resume_failed when every runtime invoke fails", async () => {
		const r = await applyPauseResume(
			SESSION,
			"resume",
			makeDeps({ invoke: vi.fn(async () => false) }),
		);
		expect(r.ok).toBe(false);
		expect(r.reason).toBe("resume_failed");
	});
});

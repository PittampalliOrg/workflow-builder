import { describe, expect, it, vi } from "vitest";
import type { LivenessReconcileCandidateRecord } from "$lib/server/application/ports";
import {
	decideSessionReconciliation,
	reconcileSessions,
	type ReconcileCandidateView,
	type ReconcileEvidence,
	type ReconcileOptions,
	type ReconcileSessionsDeps,
} from "./session-reconciler";

// --- Pure decision table -----------------------------------------------------

function view(overrides: Partial<ReconcileCandidateView> = {}): ReconcileCandidateView {
	return {
		sessionId: "s1",
		status: "running",
		isCliFamily: true,
		coordinatorOwned: false,
		paused: false,
		stopRequested: false,
		provisioned: true,
		ageSeconds: 600,
		silentSeconds: 120,
		rescueAttempts: 0,
		...overrides,
	};
}

function evidence(overrides: Partial<ReconcileEvidence> = {}): ReconcileEvidence {
	return {
		daprRuntime: "present",
		daprTerminal: false,
		sandboxCr: "present",
		pod: "present",
		podExited: false,
		...overrides,
	};
}

function decide(
	c: ReconcileCandidateView,
	e: ReconcileEvidence,
	minAgeSeconds = 300,
	silentWarnSeconds = 900,
	maxRescuesPerSession = 3,
) {
	return decideSessionReconciliation({
		candidate: c,
		evidence: e,
		minAgeSeconds,
		silentWarnSeconds,
		maxRescuesPerSession,
	});
}

describe("decideSessionReconciliation", () => {
	it("skips a paused session regardless of evidence", () => {
		expect(decide(view({ paused: true }), evidence({ daprRuntime: "absent", sandboxCr: "absent", pod: "absent" })).action).toBe("skip");
		expect(decide(view({ paused: true }), evidence()).reason).toBe("paused");
	});

	it("skips a benchmark/eval-owned instance", () => {
		expect(decide(view({ coordinatorOwned: true }), evidence()).reason).toBe("coordinator_owned");
	});

	it("skips a non-CLI-family session (v1 scope)", () => {
		expect(decide(view({ isCliFamily: false }), evidence()).reason).toBe("non_cli_family");
	});

	it("skips a never-provisioned session, but warns if stuck rescheduling past min age", () => {
		expect(decide(view({ provisioned: false, status: "idle" }), evidence()).reason).toBe("never_provisioned");
		const warn = decide(view({ provisioned: false, status: "rescheduling", ageSeconds: 400 }), evidence());
		expect(warn).toEqual({ action: "warn", reason: "never_provisioned_stuck_rescheduling" });
		// Young rescheduling → still just skip.
		expect(decide(view({ provisioned: false, status: "rescheduling", ageSeconds: 100 }), evidence()).action).toBe("skip");
	});

	it("routes a stop-intent row to confirm_stop, evidence-independent", () => {
		expect(decide(view({ stopRequested: true }), evidence({ daprRuntime: "unknown", sandboxCr: "unknown", pod: "unknown" })))
			.toEqual({ action: "confirm_stop", reason: "stop_requested" });
	});

	it("heals a Dapr-terminal-but-DB-live divergence without a cascade", () => {
		expect(decide(view(), evidence({ daprRuntime: "present", daprTerminal: true })))
			.toEqual({ action: "finalize_divergence", reason: "dapr_terminal_db_nonterminal" });
		// Even when kube evidence is unknown (divergence heal needs no kube signal).
		expect(decide(view(), evidence({ daprTerminal: true, sandboxCr: "unknown", pod: "unknown" })).action)
			.toBe("finalize_divergence");
	});

	it("converges a crash only when Dapr missing AND CR absent AND pod absent AND old enough", () => {
		const allGone = evidence({ daprRuntime: "absent", daprTerminal: false, sandboxCr: "absent", pod: "absent" });
		expect(decide(view({ ageSeconds: 600 }), allGone)).toEqual({
			action: "converge_crashed",
			reason: "dapr_missing_cr_absent_pod_absent",
		});
		// Too young → do not converge.
		expect(decide(view({ ageSeconds: 100 }), allGone).action).toBe("skip");
	});

	it("never converges when ANY evidence source is unknown (fail-safe)", () => {
		const base = { daprRuntime: "absent", sandboxCr: "absent", pod: "absent" } as const;
		for (const flake of ["daprRuntime", "sandboxCr", "pod"] as const) {
			const e = evidence({ ...base, [flake]: "unknown" });
			expect(decide(view({ ageSeconds: 600 }), e)).toEqual({ action: "skip", reason: "evidence_unknown" });
		}
	});

	it("does not converge a partially-present run (CR still there)", () => {
		expect(decide(view({ ageSeconds: 600 }), evidence({ daprRuntime: "absent", sandboxCr: "present", pod: "absent" })).action)
			.toBe("skip");
	});

	it("warns on a live-but-silent pod, but not before the silence window", () => {
		expect(decide(view({ silentSeconds: 1000 }), evidence({ pod: "present" }), 300, 900))
			.toEqual({ action: "warn", reason: "pod_present_but_silent" });
		expect(decide(view({ silentSeconds: 100 }), evidence({ pod: "present" }), 300, 900).action).toBe("skip");
		// A never-eventful session (silentSeconds null) is not warned.
		expect(decide(view({ silentSeconds: null }), evidence({ pod: "present" })).action).toBe("skip");
	});

	it("leaves a healthy running session untouched", () => {
		expect(decide(view(), evidence()).action).toBe("skip");
		expect(decide(view(), evidence()).reason).toBe("healthy_or_inconclusive");
	});

	it("rescues a stranded host: pod EXITED, CR present, session live", () => {
		const stranded = evidence({
			daprRuntime: "absent", // exited host is unaddressable via placement
			pod: "present",
			podExited: true,
			sandboxCr: "present",
		});
		expect(decide(view({ ageSeconds: 600 }), stranded)).toEqual({
			action: "rescue_stranded_host",
			reason: "pod_exited_session_live",
		});
		// Dapr evidence UNKNOWN must not block the rescue (the pod's own terminal
		// phase is the positive signal; deleting an exited pod is non-destructive).
		expect(decide(view({ ageSeconds: 600 }), evidence({ ...stranded, daprRuntime: "unknown" })).action)
			.toBe("rescue_stranded_host");
		// Too young → skip (give a just-finished pod its normal teardown window).
		expect(decide(view({ ageSeconds: 100 }), stranded).action).toBe("skip");
	});

	it("never rescues when the pod is running, the CR is gone, or Dapr says terminal", () => {
		// Running pod (podExited=false) → not a strand.
		expect(decide(view(), evidence({ pod: "present", podExited: false })).action).toBe("skip");
		// CR gone → no controller to recreate the host; not a rescue case.
		expect(
			decide(view({ ageSeconds: 600 }), evidence({ pod: "present", podExited: true, sandboxCr: "absent" })).action,
		).toBe("skip");
		// A FINISHED workflow needs finalizing, not a new host.
		expect(
			decide(
				view({ ageSeconds: 600 }),
				evidence({ pod: "present", podExited: true, daprTerminal: true }),
			).action,
		).toBe("finalize_divergence");
		// Stop-intent wins over rescue (the user asked for it to stop).
		expect(
			decide(
				view({ ageSeconds: 600, stopRequested: true }),
				evidence({ pod: "present", podExited: true }),
			).action,
		).toBe("confirm_stop");
	});

	it("degrades to an audit-only warn once the rescue cap is exhausted", () => {
		const stranded = evidence({ daprRuntime: "absent", pod: "present", podExited: true });
		expect(decide(view({ ageSeconds: 600, rescueAttempts: 3 }), stranded)).toEqual({
			action: "warn",
			reason: "rescue_cap_exhausted",
		});
		// An unreadable rescue count arrives as +Infinity → fail safe (warn).
		expect(
			decide(view({ ageSeconds: 600, rescueAttempts: Number.POSITIVE_INFINITY }), stranded).action,
		).toBe("warn");
		// maxRescuesPerSession=0 disables the rescue entirely.
		expect(decide(view({ ageSeconds: 600 }), stranded, 300, 900, 0).action).toBe("warn");
	});

	it("handles a status='failed' row identically to any other (no special-casing)", () => {
		// A LIVE turn-failure `failed` row whose pod is still up is left alone.
		expect(
			decide(view({ status: "failed" }), evidence({ pod: "present" })).action,
		).toBe("skip");
		// Once its pod (and the rest) are gone, the all-absent rule converges it —
		// converge_crashed then stamps completedAt so it never re-appears as a candidate.
		expect(
			decide(
				view({ status: "failed", ageSeconds: 600 }),
				evidence({ daprRuntime: "absent", sandboxCr: "absent", pod: "absent" }),
			),
		).toEqual({ action: "converge_crashed", reason: "dapr_missing_cr_absent_pod_absent" });
		// A probe flake on a failed row still never converges.
		expect(
			decide(view({ status: "failed" }), evidence({ daprRuntime: "absent", sandboxCr: "unknown", pod: "absent" })).action,
		).toBe("skip");
	});
});

// --- reconcileSessions integration (fake deps) -------------------------------

function candidateRecord(
	overrides: Partial<LivenessReconcileCandidateRecord> = {},
): LivenessReconcileCandidateRecord {
	const old = new Date(Date.now() - 600_000); // 10 min ago
	return {
		id: "s1",
		status: "running",
		agentId: "agent-1",
		agentVersion: 1,
		agentSlug: "claude-cli",
		agentRuntime: "claude-code-cli",
		userId: "user-1",
		projectId: "project-1",
		title: "Session",
		resumedFromSessionId: null,
		runtimeAppId: "agent-session-1",
		daprInstanceId: "s1",
		runtimeSandboxName: "agent-host-agent-session-1",
		pauseRequestedAt: null,
		stopRequestedAt: null,
		coordinatorOwned: false,
		updatedAt: old,
		lastEventAt: old,
		...overrides,
	};
}

function fakeDeps(
	candidates: LivenessReconcileCandidateRecord[],
	overrides: Partial<ReconcileSessionsDeps> = {},
): ReconcileSessionsDeps {
	return {
		listCandidates: vi.fn(async () => candidates),
		isCliFamily: vi.fn(() => true),
		// Default probes report a crashed run (all gone).
		probeDaprRuntime: vi.fn(async () => ({ runtime: "absent" as const, terminal: false })),
		probeSandboxCr: vi.fn(async () => "absent" as const),
		probePod: vi.fn(async () => ({ state: "absent" as const, exited: false })),
		countRescueAttempts: vi.fn(async () => 0),
		rescueStrandedHost: vi.fn(async () => undefined),
		now: () => Date.now(),
		appendAudit: vi.fn(async () => undefined),
		confirmStop: vi.fn(async () => undefined),
		convergeCrashed: vi.fn(async () => undefined),
		cleanupWorkspace: vi.fn(async () => undefined),
		maybeAutoResume: vi.fn(async () => ({ resumed: true, reason: "non_graceful_exit", newSessionId: "s2" })),
		...overrides,
	};
}

const OPTS: ReconcileOptions = {
	dryRun: false,
	limit: 50,
	minAgeSeconds: 300,
	silentWarnSeconds: 900,
	maxActionsPerRun: 10,
	autoResume: false,
	maxRescuesPerSession: 3,
};

describe("reconcileSessions", () => {
	it("converges a crashed session through the controller with an audit first", async () => {
		const deps = fakeDeps([candidateRecord()]);
		const result = await reconcileSessions(deps, OPTS);

		expect(result.scanned).toBe(1);
		expect(result.actionsTaken).toBe(1);
		expect(result.decisions[0]).toMatchObject({ action: "converge_crashed", executed: true });
		expect(deps.appendAudit).toHaveBeenCalledWith("s1", expect.objectContaining({ action: "converge_crashed" }));
		expect(deps.convergeCrashed).toHaveBeenCalledWith("s1", "dapr_missing_cr_absent_pod_absent");
		// Auto-resume OFF → never called even on a converge.
		expect(deps.maybeAutoResume).not.toHaveBeenCalled();
	});

	it("dry-run takes ZERO writes", async () => {
		const deps = fakeDeps([candidateRecord()]);
		const result = await reconcileSessions(deps, { ...OPTS, dryRun: true });

		expect(result.dryRun).toBe(true);
		expect(result.actionsTaken).toBe(0);
		expect(result.decisions[0]).toMatchObject({ action: "converge_crashed", executed: false });
		expect(deps.appendAudit).not.toHaveBeenCalled();
		expect(deps.convergeCrashed).not.toHaveBeenCalled();
	});

	it("honors the per-run action cap", async () => {
		const deps = fakeDeps([
			candidateRecord({ id: "s1" }),
			candidateRecord({ id: "s2" }),
			candidateRecord({ id: "s3" }),
		]);
		const result = await reconcileSessions(deps, { ...OPTS, maxActionsPerRun: 1 });

		expect(result.scanned).toBe(3);
		expect(result.actionsTaken).toBe(1);
		expect(deps.convergeCrashed).toHaveBeenCalledTimes(1);
		expect(result.decisions.filter((d) => d.executed)).toHaveLength(1);
		// The capped ones are still recorded (for observability), tagged.
		const capped = result.decisions.filter((d) => !d.executed);
		expect(capped).toHaveLength(2);
		expect(capped[0].reason).toContain("action_cap_reached");
	});

	it("skips probes and writes for evidence-free skip classes", async () => {
		const deps = fakeDeps([candidateRecord({ pauseRequestedAt: new Date() })]);
		const result = await reconcileSessions(deps, OPTS);

		expect(result.decisions[0]).toMatchObject({ action: "skip", reason: "paused" });
		expect(deps.probeDaprRuntime).not.toHaveBeenCalled();
		expect(deps.probeSandboxCr).not.toHaveBeenCalled();
		expect(deps.convergeCrashed).not.toHaveBeenCalled();
	});

	it("routes a stop-intent row to confirmStop WITHOUT probing (evidence-independent)", async () => {
		const deps = fakeDeps([candidateRecord({ stopRequestedAt: new Date(Date.now() - 600_000) })]);
		await reconcileSessions(deps, OPTS);
		expect(deps.confirmStop).toHaveBeenCalledWith("s1");
		expect(deps.convergeCrashed).not.toHaveBeenCalled();
		// confirm_stop is decided from the row alone → the 3 probes are skipped.
		expect(deps.probeDaprRuntime).not.toHaveBeenCalled();
		expect(deps.probeSandboxCr).not.toHaveBeenCalled();
		expect(deps.probePod).not.toHaveBeenCalled();
	});

	it("heals a Dapr-terminal divergence via confirmStop without a cascade", async () => {
		const deps = fakeDeps([candidateRecord()], {
			probeDaprRuntime: vi.fn(async () => ({ runtime: "present" as const, terminal: true })),
			probeSandboxCr: vi.fn(async () => "present" as const),
			probePod: vi.fn(async () => ({ state: "present" as const, exited: false })),
		});
		const result = await reconcileSessions(deps, OPTS);
		expect(result.decisions[0].action).toBe("finalize_divergence");
		expect(deps.confirmStop).toHaveBeenCalledWith("s1");
		expect(deps.convergeCrashed).not.toHaveBeenCalled();
	});

	it("never converges a session on a probe flake (unknown evidence)", async () => {
		const deps = fakeDeps([candidateRecord()], {
			probeSandboxCr: vi.fn(async () => "unknown" as const),
		});
		const result = await reconcileSessions(deps, OPTS);
		expect(result.decisions[0]).toMatchObject({ action: "skip", reason: "evidence_unknown" });
		expect(result.actionsTaken).toBe(0);
		expect(deps.convergeCrashed).not.toHaveBeenCalled();
	});

	it("leaves a healthy running session untouched", async () => {
		const deps = fakeDeps([candidateRecord()], {
			probeDaprRuntime: vi.fn(async () => ({ runtime: "present" as const, terminal: false })),
			probeSandboxCr: vi.fn(async () => "present" as const),
			probePod: vi.fn(async () => ({ state: "present" as const, exited: false })),
		});
		const result = await reconcileSessions(deps, OPTS);
		expect(result.decisions[0].action).toBe("skip");
		expect(result.actionsTaken).toBe(0);
	});

	it("invokes gated auto-resume after a converge when enabled", async () => {
		const deps = fakeDeps([candidateRecord()]);
		const result = await reconcileSessions(deps, { ...OPTS, autoResume: true });
		expect(deps.convergeCrashed).toHaveBeenCalledOnce();
		expect(deps.maybeAutoResume).toHaveBeenCalledOnce();
		expect(result.decisions[0].autoResumed).toBe(true);
	});

	it("does NOT count a warn against the action cap (warns never starve converges)", async () => {
		// warn-1 (oldest-first) is a live-but-silent pod → warn; crash-1 is all-gone
		// → converge. With cap=1, if the warn consumed the budget the converge would
		// be starved. It must not.
		const warnCand = candidateRecord({
			id: "warn-1",
			lastEventAt: new Date(Date.now() - 3_600_000),
		});
		const crashCand = candidateRecord({ id: "crash-1" });
		const deps = fakeDeps([warnCand, crashCand], {
			probeDaprRuntime: vi.fn(async (c) =>
				c.id === "warn-1"
					? { runtime: "present" as const, terminal: false }
					: { runtime: "absent" as const, terminal: false },
			),
			probeSandboxCr: vi.fn(async (c) => (c.id === "warn-1" ? "present" : "absent")),
			probePod: vi.fn(async (c) =>
				c.id === "warn-1"
					? { state: "present" as const, exited: false }
					: { state: "absent" as const, exited: false },
			),
		});

		const result = await reconcileSessions(deps, { ...OPTS, maxActionsPerRun: 1 });

		expect(result.decisions.find((d) => d.sessionId === "warn-1")).toMatchObject({
			action: "warn",
			executed: true,
		});
		expect(result.decisions.find((d) => d.sessionId === "crash-1")).toMatchObject({
			action: "converge_crashed",
			executed: true,
		});
		expect(deps.convergeCrashed).toHaveBeenCalledWith("crash-1", expect.any(String));
		// Only the converge consumed the budget.
		expect(result.actionsTaken).toBe(1);
	});

	it("rescues a stranded host through deps with the attempt index", async () => {
		const deps = fakeDeps([candidateRecord()], {
			probeDaprRuntime: vi.fn(async () => ({ runtime: "absent" as const, terminal: false })),
			probeSandboxCr: vi.fn(async () => "present" as const),
			probePod: vi.fn(async () => ({ state: "present" as const, exited: true })),
			countRescueAttempts: vi.fn(async () => 1),
		});
		const result = await reconcileSessions(deps, OPTS);
		expect(result.decisions[0]).toMatchObject({
			action: "rescue_stranded_host",
			executed: true,
		});
		expect(deps.rescueStrandedHost).toHaveBeenCalledWith(
			expect.objectContaining({ id: "s1" }),
			1,
		);
		// A rescue never converges/stops anything.
		expect(deps.convergeCrashed).not.toHaveBeenCalled();
		expect(deps.confirmStop).not.toHaveBeenCalled();
		// Rescue consumes the action budget (it is a real mutation).
		expect(result.actionsTaken).toBe(1);
	});

	it("degrades to a warn (no rescue call) once the cap is exhausted", async () => {
		const deps = fakeDeps([candidateRecord()], {
			probeDaprRuntime: vi.fn(async () => ({ runtime: "absent" as const, terminal: false })),
			probeSandboxCr: vi.fn(async () => "present" as const),
			probePod: vi.fn(async () => ({ state: "present" as const, exited: true })),
			countRescueAttempts: vi.fn(async () => 3),
		});
		const result = await reconcileSessions(deps, OPTS);
		expect(result.decisions[0]).toMatchObject({
			action: "warn",
			reason: "rescue_cap_exhausted",
		});
		expect(deps.rescueStrandedHost).not.toHaveBeenCalled();
		// warns never consume the action budget.
		expect(result.actionsTaken).toBe(0);
	});

	it("fails safe when the rescue count is unreadable (warn, no rescue)", async () => {
		const deps = fakeDeps([candidateRecord()], {
			probeDaprRuntime: vi.fn(async () => ({ runtime: "absent" as const, terminal: false })),
			probeSandboxCr: vi.fn(async () => "present" as const),
			probePod: vi.fn(async () => ({ state: "present" as const, exited: true })),
			countRescueAttempts: vi.fn(async () => {
				throw new Error("db unavailable");
			}),
		});
		const result = await reconcileSessions(deps, OPTS);
		expect(result.decisions[0]).toMatchObject({
			action: "warn",
			reason: "rescue_cap_exhausted",
		});
		expect(deps.rescueStrandedHost).not.toHaveBeenCalled();
	});

	it("dry-run records a rescue decision without touching the pod", async () => {
		const deps = fakeDeps([candidateRecord()], {
			probeDaprRuntime: vi.fn(async () => ({ runtime: "absent" as const, terminal: false })),
			probeSandboxCr: vi.fn(async () => "present" as const),
			probePod: vi.fn(async () => ({ state: "present" as const, exited: true })),
		});
		const result = await reconcileSessions(deps, { ...OPTS, dryRun: true });
		expect(result.decisions[0]).toMatchObject({
			action: "rescue_stranded_host",
			executed: false,
		});
		expect(deps.rescueStrandedHost).not.toHaveBeenCalled();
		expect(deps.appendAudit).not.toHaveBeenCalled();
	});
});

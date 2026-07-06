/**
 * Session liveness reconciler — Dapr-evidence-first.
 *
 * Recovers sessions whose DB row is still non-terminal (running/idle/
 * rescheduling) while the backing durable run has actually died — a pod death /
 * OOM / node failure / image-pin rollout that left no `session.status_terminated`
 * behind, so the row would otherwise read "running" forever. It observes each
 * candidate through THREE independent, tri-state evidence sources (Dapr workflow
 * runtime status, the K8s Sandbox CR, the runtime pod) plus the throttled
 * `last_event_at` silence stamp, and converges only on POSITIVE, corroborating
 * evidence that the run is gone — never on a single flaky signal.
 *
 * The split mirrors `cascade.ts` / `auto-resume.ts`:
 *   - `decideSessionReconciliation` is PURE (no I/O, no env) and exhaustively
 *     unit-tested over the evidence matrix. ANY `unknown` evidence ⇒ skip.
 *   - `reconcileSessions(deps, opts)` is the deps-injected orchestration; every
 *     Dapr/K8s/DB side effect is supplied through {@link ReconcileSessionsDeps}
 *     (wired for real in `adapters/session-reconciler-deps.ts`).
 *
 * Convergence NEVER does a bespoke DB flip: `converge_crashed` runs through the
 * Lifecycle Controller (`convergeCrashedSession`) so Dapr terminate/purge, the
 * Sandbox CR reap, and the DB finalize all happen together (row → `failed` +
 * stopReason `crashed`). A stop-intent row routes to the controller's
 * `confirmDurableStop` (its unattended cross-app wedge sweep runs for free), and
 * a Dapr-terminal-but-DB-live divergence is finalized the same way (no cascade).
 */
import type { LivenessReconcileCandidateRecord } from "$lib/server/application/ports";
import { runWithConcurrency } from "./cascade";

/** Bounded fan-out for the read-only evidence-gathering phase (actions stay serial). */
const PROBE_CONCURRENCY = 4;

// --- Pure core --------------------------------------------------------------

/** Tri-state evidence. `unknown` (a transient/API error) always fails safe. */
export type ReconcileEvidenceState = "present" | "absent" | "unknown";

export type ReconcileEvidence = {
	/**
	 * Dapr workflow runtime status of the session's per-session instance:
	 *   present = a live/non-terminal status was read;
	 *   absent  = `__missing__` (no such instance, or the per-session app-id is
	 *             unresolvable via placement — the pod is gone);
	 *   unknown = a transient invoke error / the target couldn't be addressed.
	 */
	daprRuntime: ReconcileEvidenceState;
	/**
	 * true when the Dapr status was read AND is a TERMINAL status (COMPLETED /
	 * FAILED / …). The divergence-heal signal — distinct from `daprRuntime:absent`
	 * (which means the instance is GONE, not that it finished).
	 */
	daprTerminal: boolean;
	/** Sandbox CR: present = exists; absent = 404; unknown = API error. */
	sandboxCr: ReconcileEvidenceState;
	/** Runtime pod: present = found; absent = not found; unknown = API error. */
	pod: ReconcileEvidenceState;
};

export type ReconcileCandidateView = {
	sessionId: string;
	status: string;
	/** The session's runtime is the interactive-cli family (v1 scope). */
	isCliFamily: boolean;
	/** A benchmark/eval coordinator owns this instance (single stop authority). */
	coordinatorOwned: boolean;
	/** status==='paused' OR pause-intent set — an intentional hold, never converge. */
	paused: boolean;
	/** stop-intent set — route to confirmDurableStop (unattended wedge sweep). */
	stopRequested: boolean;
	/** A per-session runtime app-id was ever assigned (i.e. it actually launched). */
	provisioned: boolean;
	/** now − updated_at, seconds. */
	ageSeconds: number;
	/** now − last_event_at, seconds; null when no event was ever ingested. */
	silentSeconds: number | null;
};

export type ReconcileActionKind =
	| "skip"
	| "warn"
	| "confirm_stop"
	| "finalize_divergence"
	| "converge_crashed";

export type ReconcileAction = { action: ReconcileActionKind; reason: string };

export type ReconcileDecisionInput = {
	candidate: ReconcileCandidateView;
	evidence: ReconcileEvidence;
	minAgeSeconds: number;
	silentWarnSeconds: number;
};

/**
 * PURE decision — no I/O, no env, no clock. Order is load-bearing (see comments).
 * The cardinal safety rule: past the evidence-free skips and the two positive
 * KNOWN signals (stop-intent, Dapr-terminal), ANY `unknown` evidence ⇒ skip, so a
 * kube/Dapr flake can never converge a live session.
 */
export function decideSessionReconciliation(
	input: ReconcileDecisionInput,
): ReconcileAction {
	const { candidate: c, evidence: e } = input;

	// (1) Evidence-free hard skips — classes we never touch regardless of state.
	if (c.paused) return { action: "skip", reason: "paused" };
	if (c.coordinatorOwned) return { action: "skip", reason: "coordinator_owned" };
	if (!c.isCliFamily) return { action: "skip", reason: "non_cli_family" };
	if (!c.provisioned) {
		// Never provisioned: nothing to converge. Surface a warn only if it has been
		// stuck `rescheduling` (never got a pod) longer than the min age.
		return c.status === "rescheduling" && c.ageSeconds >= input.minAgeSeconds
			? { action: "warn", reason: "never_provisioned_stuck_rescheduling" }
			: { action: "skip", reason: "never_provisioned" };
	}

	// (2) Stop-intent → hand to the controller's confirm/wedge-sweep. Evidence-
	//     independent: confirmDurableStop re-checks every handle itself.
	if (c.stopRequested) return { action: "confirm_stop", reason: "stop_requested" };

	// (3) Dapr reports the instance TERMINAL while the DB row is still live — a
	//     missed status_terminated. Heal the divergence (finalize only, no
	//     cascade). A positive KNOWN signal, so kube evidence being unknown is
	//     irrelevant here.
	if (e.daprTerminal) {
		return { action: "finalize_divergence", reason: "dapr_terminal_db_nonterminal" };
	}

	// (4) Fail-safe gate: any unknown evidence past this point ⇒ skip. A transient
	//     kube/Dapr error must NEVER converge a session.
	if (
		e.daprRuntime === "unknown" ||
		e.sandboxCr === "unknown" ||
		e.pod === "unknown"
	) {
		return { action: "skip", reason: "evidence_unknown" };
	}

	// (5) All three sources agree the run is GONE (Dapr instance missing, CR
	//     absent, pod absent) and it is old enough → crashed. Converge. Works
	//     identically for a live turn-failure `failed` row whose pod later died —
	//     the candidate query supplies non-finalized failed rows (completedAt IS
	//     NULL); converge_crashed then stamps completedAt so it never re-appears.
	if (
		e.daprRuntime === "absent" &&
		e.sandboxCr === "absent" &&
		e.pod === "absent" &&
		c.ageSeconds >= input.minAgeSeconds
	) {
		return {
			action: "converge_crashed",
			reason: "dapr_missing_cr_absent_pod_absent",
		};
	}

	// (6) The pod is alive but the session has been silent past the warn window —
	//     surface it (watchdog attribution); do NOT converge a live pod.
	if (
		e.pod === "present" &&
		c.silentSeconds != null &&
		c.silentSeconds >= input.silentWarnSeconds
	) {
		return { action: "warn", reason: "pod_present_but_silent" };
	}

	return { action: "skip", reason: "healthy_or_inconclusive" };
}

// --- I/O orchestration (deps-injected) --------------------------------------

export type ReconcileAuditData = {
	action: ReconcileActionKind;
	reason: string;
	/** Compact Dapr evidence, e.g. `absent`, `present`, `present:terminal`, `unknown`. */
	daprStatus: string;
	crName: string | null;
	lastEventAt: string | null;
};

export type ReconcileSessionsDeps = {
	listCandidates(input: {
		minAgeSeconds: number;
		limit: number;
	}): Promise<LivenessReconcileCandidateRecord[]>;
	isCliFamily(agentRuntime: string | null): boolean;
	probeDaprRuntime(
		candidate: LivenessReconcileCandidateRecord,
	): Promise<{ runtime: ReconcileEvidenceState; terminal: boolean }>;
	probeSandboxCr(
		candidate: LivenessReconcileCandidateRecord,
	): Promise<ReconcileEvidenceState>;
	probePod(
		candidate: LivenessReconcileCandidateRecord,
	): Promise<ReconcileEvidenceState>;
	now(): number;
	/** Append a `session.reconciler_action` audit event to the session's stream. */
	appendAudit(sessionId: string, data: ReconcileAuditData): Promise<void>;
	/** confirmDurableStop({kind:"session"}) — used for BOTH confirm_stop and finalize_divergence. */
	confirmStop(sessionId: string): Promise<void>;
	/** convergeCrashedSession({kind:"session"}) — cascade purge + reap + finalize `crashed`. */
	convergeCrashed(sessionId: string, reason: string): Promise<void>;
	/** Best-effort workspace cleanup after a crash converge (optional). */
	cleanupWorkspace?(candidate: LivenessReconcileCandidateRecord): Promise<void>;
	/** Gated auto-resume of a converged crash (optional; only called when opts.autoResume). */
	maybeAutoResume?(
		candidate: LivenessReconcileCandidateRecord,
	): Promise<{ resumed: boolean; reason: string; newSessionId?: string }>;
};

export type ReconcileOptions = {
	dryRun: boolean;
	limit: number;
	minAgeSeconds: number;
	silentWarnSeconds: number;
	maxActionsPerRun: number;
	autoResume: boolean;
};

export type ReconcileDecisionRecord = {
	sessionId: string;
	action: ReconcileActionKind;
	reason: string;
	/** true when the side effect ran (false in dry-run or once the action cap is hit). */
	executed: boolean;
	daprRuntime: ReconcileEvidenceState;
	daprTerminal: boolean;
	sandboxCr: ReconcileEvidenceState;
	pod: ReconcileEvidenceState;
	autoResumed?: boolean;
};

export type ReconcileRunResult = {
	scanned: number;
	decisions: ReconcileDecisionRecord[];
	actionsTaken: number;
	dryRun: boolean;
};

const UNKNOWN_EVIDENCE: ReconcileEvidence = {
	daprRuntime: "unknown",
	daprTerminal: false,
	sandboxCr: "unknown",
	pod: "unknown",
};

function daprStatusLabel(e: ReconcileEvidence): string {
	if (e.daprTerminal) return `${e.daprRuntime}:terminal`;
	return e.daprRuntime;
}

/**
 * Scan candidates, gather evidence, decide, and (unless dry-run / capped) execute
 * through the injected deps. Fail-soft per candidate — a probe/action error on one
 * session never aborts the sweep.
 */
export async function reconcileSessions(
	deps: ReconcileSessionsDeps,
	opts: ReconcileOptions,
): Promise<ReconcileRunResult> {
	const candidates = await deps.listCandidates({
		minAgeSeconds: opts.minAgeSeconds,
		limit: opts.limit,
	});

	// Phase 1 — gather evidence with bounded concurrency (all probes are read-only,
	// so fanning them out is safe). Evidence-free classes (paused / coordinator /
	// non-cli / never-provisioned) AND stop-intent rows (confirm_stop re-checks
	// every handle itself) are decided from the row alone → they never probe.
	type Prepared = {
		cand: LivenessReconcileCandidateRecord;
		view: ReconcileCandidateView;
		evidence: ReconcileEvidence;
	};
	const prepared = new Array<Prepared | undefined>(candidates.length);
	await runWithConcurrency(
		candidates.map((cand, index) => ({ cand, index })),
		PROBE_CONCURRENCY,
		async ({ cand, index }) => {
			const now = deps.now();
			const isCliFamily = deps.isCliFamily(cand.agentRuntime);
			const paused = cand.status === "paused" || cand.pauseRequestedAt != null;
			const stopRequested = cand.stopRequestedAt != null;
			const provisioned = !!cand.runtimeAppId;
			const view: ReconcileCandidateView = {
				sessionId: cand.id,
				status: cand.status,
				isCliFamily,
				coordinatorOwned: cand.coordinatorOwned,
				paused,
				stopRequested,
				provisioned,
				ageSeconds: Math.max(0, Math.floor((now - cand.updatedAt.getTime()) / 1000)),
				silentSeconds: cand.lastEventAt
					? Math.max(0, Math.floor((now - cand.lastEventAt.getTime()) / 1000))
					: null,
			};
			let evidence = UNKNOWN_EVIDENCE;
			const needsEvidence =
				isCliFamily &&
				!paused &&
				!stopRequested &&
				!cand.coordinatorOwned &&
				provisioned;
			if (needsEvidence) {
				const [dapr, sandboxCr, pod] = await Promise.all([
					deps
						.probeDaprRuntime(cand)
						.catch(() => ({ runtime: "unknown" as const, terminal: false })),
					deps.probeSandboxCr(cand).catch(() => "unknown" as const),
					deps.probePod(cand).catch(() => "unknown" as const),
				]);
				evidence = { daprRuntime: dapr.runtime, daprTerminal: dapr.terminal, sandboxCr, pod };
			}
			prepared[index] = { cand, view, evidence };
		},
	);

	// Phase 2 — decide + execute SERIALLY (in the candidate's oldest-first order) so
	// the action-cap accounting stays exact.
	const decisions: ReconcileDecisionRecord[] = [];
	let actionsTaken = 0;
	for (const item of prepared) {
		if (!item) continue; // a phase-1 worker never throws, but stay defensive
		const { cand, view, evidence } = item;
		const decision = decideSessionReconciliation({
			candidate: view,
			evidence,
			minAgeSeconds: opts.minAgeSeconds,
			silentWarnSeconds: opts.silentWarnSeconds,
		});

		const record: ReconcileDecisionRecord = {
			sessionId: cand.id,
			action: decision.action,
			reason: decision.reason,
			executed: false,
			daprRuntime: evidence.daprRuntime,
			daprTerminal: evidence.daprTerminal,
			sandboxCr: evidence.sandboxCr,
			pod: evidence.pod,
		};

		if (decision.action !== "skip") {
			// A `warn` is an audit-only write — it does NOT consume the action budget.
			// Otherwise a handful of oldest-first quiet-but-alive sessions would
			// permanently starve converge_crashed. Only converge/confirm/finalize
			// (and the auto-resume they carry) count against the cap.
			const consumesBudget = decision.action !== "warn";
			if (opts.dryRun) {
				// record only — dry-run takes ZERO writes.
			} else if (consumesBudget && actionsTaken >= opts.maxActionsPerRun) {
				// Action cap reached: leave the rest for the next tick.
				record.reason = `${decision.reason}:action_cap_reached`;
			} else {
				await executeAction(deps, cand, decision, evidence, opts, record);
				record.executed = true;
				if (consumesBudget) actionsTaken += 1;
			}
		}

		decisions.push(record);
	}

	return {
		scanned: candidates.length,
		decisions,
		actionsTaken,
		dryRun: opts.dryRun,
	};
}

async function executeAction(
	deps: ReconcileSessionsDeps,
	cand: LivenessReconcileCandidateRecord,
	decision: ReconcileAction,
	evidence: ReconcileEvidence,
	opts: ReconcileOptions,
	record: ReconcileDecisionRecord,
): Promise<void> {
	// Audit FIRST (watchdog attribution) — always precedes the mutating action so
	// even a subsequent failure leaves a trail on the session's own stream.
	await deps
		.appendAudit(cand.id, {
			action: decision.action,
			reason: decision.reason,
			daprStatus: daprStatusLabel(evidence),
			crName: cand.runtimeSandboxName,
			lastEventAt: cand.lastEventAt?.toISOString() ?? null,
		})
		.catch((err) => {
			console.warn(
				`[session-reconciler] audit append failed for ${cand.id}:`,
				err instanceof Error ? err.message : err,
			);
		});

	switch (decision.action) {
		case "warn":
			// Audit-only — the warn IS the audit event above.
			break;
		case "confirm_stop":
		case "finalize_divergence":
			// Both route to confirmDurableStop: for a stop-intent row it runs the
			// cross-app wedge sweep; for a Dapr-terminal row its all-closed path
			// finalizes the divergence. No cascade issued either way.
			await deps.confirmStop(cand.id).catch((err) => {
				console.warn(
					`[session-reconciler] confirmStop failed for ${cand.id}:`,
					err instanceof Error ? err.message : err,
				);
			});
			break;
		case "converge_crashed":
			await deps.convergeCrashed(cand.id, decision.reason).catch((err) => {
				console.warn(
					`[session-reconciler] convergeCrashed failed for ${cand.id}:`,
					err instanceof Error ? err.message : err,
				);
			});
			await deps.cleanupWorkspace?.(cand).catch(() => {});
			if (opts.autoResume && deps.maybeAutoResume) {
				const resumed = await deps
					.maybeAutoResume(cand)
					.catch(() => ({ resumed: false, reason: "auto_resume_error" }));
				record.autoResumed = resumed.resumed;
			}
			break;
	}
}

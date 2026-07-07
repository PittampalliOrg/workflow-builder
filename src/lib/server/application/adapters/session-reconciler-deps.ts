/**
 * Real (Dapr/K8s/DB-backed) wiring for the session liveness reconciler — the
 * counterpart to `session-reconciler.ts`'s pure core + deps-injected engine,
 * exactly as `adapters/lifecycle-cascade.ts` backs `lifecycle/cascade.ts`.
 *
 * `runSessionReconcile` is the single entry point both tick surfaces call: the
 * Dapr Job callback route and the internal `POST /api/internal/sessions/reconcile`
 * ops/CronJob endpoint. Config (enabled / dry-run / thresholds / tick mode) is
 * read from env with safe defaults (`DRY_RUN` defaults ON).
 */
import { timingSafeEqual } from "node:crypto";
import { env } from "$env/dynamic/private";
import { readAdapter, readFlag } from "$lib/server/application/config";
import { createDaprCascadeDeps } from "$lib/server/application/adapters/lifecycle-cascade";
import { CurrentSessionRepository } from "$lib/server/application/adapters/sessions";
import { resolveAgentRef } from "$lib/server/application/adapters/agent-registry";
import { appendSessionEvent } from "$lib/server/application/adapters/session-events";
import { getRuntimeDescriptor } from "$lib/server/agents/runtime-registry";
import {
	confirmDurableStop,
	convergeCrashedSession,
} from "$lib/server/lifecycle";
import {
	DURABLE_RUNTIME_MISSING_STATUS,
	isTerminalDurableRuntimeStatus,
} from "$lib/server/lifecycle/cascade";
import { agentTargetForSession } from "$lib/server/lifecycle/resolvers";
import {
	reconcileSessions,
	type ReconcileEvidenceState,
	type ReconcileOptions,
	type ReconcileRunResult,
	type ReconcileSessionsDeps,
} from "$lib/server/lifecycle/session-reconciler";
import { maybeAutoResumeSession } from "$lib/server/lifecycle/auto-resume";
import {
	deleteSessionRuntimeExitedPods,
	getKubernetesSandbox,
	getSessionRuntimePodStatus,
} from "$lib/server/kube/client";
import { countEventsByType } from "$lib/server/application/adapters/session-events";
import { daprFetch, getDaprSidecarUrl } from "$lib/server/dapr-client";
import { cleanupSessionSandbox } from "$lib/server/sandboxes/provision";
import { isInteractiveCliRuntime } from "$lib/server/sessions/resume";
import { spawnSessionWorkflow } from "$lib/server/sessions/spawn";
import type { LivenessReconcileCandidateRecord } from "$lib/server/application/ports";

export type ReconcilerTickMode = "dapr-job" | "cronjob" | "off";

export type ReconcilerConfig = {
	enabled: boolean;
	dryRun: boolean;
	minAgeSeconds: number;
	silentWarnSeconds: number;
	autoResume: boolean;
	maxActionsPerRun: number;
	scanLimit: number;
	tick: ReconcilerTickMode;
	/** Stranded-host rescue attempts allowed per session (0 disables rescue). */
	maxRescuesPerSession: number;
};

const TICK_MODES: readonly ReconcilerTickMode[] = ["dapr-job", "cronjob", "off"];

function readEnv(name: string): string {
	return (env[name] ?? process.env[name] ?? "").trim();
}

// Clamped-int env reader — the one shape config.ts's readFlag/readAdapter (reused
// below) don't cover (envSeconds in lifecycle/index.ts is MS-scaled + private).
function readInt(name: string, fallback: number, min: number, max: number): number {
	const n = Number.parseInt(readEnv(name), 10);
	const v = Number.isFinite(n) ? n : fallback;
	return Math.max(min, Math.min(max, v));
}

export function readReconcilerConfig(): ReconcilerConfig {
	const maxActionsPerRun = readInt("SESSION_RECONCILER_MAX_ACTIONS_PER_RUN", 10, 1, 1000);
	return {
		enabled: readFlag(env, "SESSION_RECONCILER_ENABLED", true),
		dryRun: readFlag(env, "SESSION_RECONCILER_DRY_RUN", true),
		minAgeSeconds: readInt("SESSION_RECONCILER_MIN_AGE_SECONDS", 300, 30, 86_400),
		silentWarnSeconds: readInt("SESSION_RECONCILER_SILENT_WARN_SECONDS", 900, 30, 86_400),
		autoResume: readFlag(env, "SESSION_RECONCILER_AUTO_RESUME", false),
		maxActionsPerRun,
		// Scan more than we'll act on so a run drains the backlog over ticks.
		scanLimit: Math.max(50, Math.min(200, maxActionsPerRun * 5)),
		tick: readAdapter(env, "SESSION_RECONCILER_TICK", "dapr-job", TICK_MODES),
		maxRescuesPerSession: readInt("SESSION_RECONCILER_MAX_RESCUES", 3, 0, 20),
	};
}

function classifyDaprStatus(raw: unknown): {
	runtime: ReconcileEvidenceState;
	terminal: boolean;
} {
	if (raw === DURABLE_RUNTIME_MISSING_STATUS) return { runtime: "absent", terminal: false };
	if (raw === null || raw === undefined) return { runtime: "unknown", terminal: false };
	if (isTerminalDurableRuntimeStatus(raw)) return { runtime: "present", terminal: true };
	return { runtime: "present", terminal: false };
}

export function createSessionReconcilerDeps(): ReconcileSessionsDeps {
	const cascadeDeps = createDaprCascadeDeps();
	const sessionRepo = new CurrentSessionRepository();

	// Auto-resume wiring (only exercised when SESSION_RECONCILER_AUTO_RESUME=on AND
	// the agent's autoResume policy allows — maybeAutoResumeSession gates both).
	const autoResumeDeps = {
		resolveAgent: async (ref: { id: string; version?: number }) => {
			const resolved = await resolveAgentRef({ id: ref.id, version: ref.version });
			if (!resolved) return null;
			return {
				runtime: String(resolved.runtime),
				config: (resolved.config ?? {}) as Record<string, unknown>,
			};
		},
		getRuntimeDescriptor: (runtime: string) => getRuntimeDescriptor(runtime),
		getResumedFrom: async (id: string) =>
			(await sessionRepo.getSession(id))?.resumedFromSessionId ?? null,
		createSession: async (input: {
			agentId: string;
			agentVersion?: number;
			userId: string;
			projectId: string | null;
			title?: string;
			resumedFromSessionId: string | null;
		}) => {
			const created = await sessionRepo.createSession({
				agentId: input.agentId,
				agentVersion: input.agentVersion,
				userId: input.userId,
				projectId: input.projectId,
				title: input.title,
				resumedFromSessionId: input.resumedFromSessionId,
			});
			return { id: created.id };
		},
		spawnSessionWorkflow: (sessionId: string) => spawnSessionWorkflow(sessionId),
	};

	return {
		listCandidates: (input) => sessionRepo.listLivenessReconcileCandidates(input),
		isCliFamily: (agentRuntime) =>
			isInteractiveCliRuntime(getRuntimeDescriptor(agentRuntime ?? "")),
		probeDaprRuntime: async (cand) => {
			const target = agentTargetForSession({
				id: cand.id,
				daprInstanceId: cand.daprInstanceId,
				runtimeAppId: cand.runtimeAppId,
				runtimeSandboxName: cand.runtimeSandboxName,
			});
			// No addressable per-session instance ⇒ we can't prove it's gone → unknown
			// (fail safe: never converge on an unresolvable target).
			if (!target) return { runtime: "unknown" as const, terminal: false };
			try {
				const raw = await cascadeDeps.getAgentRuntimeStatus(
					target.runtimeAppId,
					target.instanceId,
				);
				return classifyDaprStatus(raw);
			} catch {
				// A non-transient status error is still ambiguous — treat as unknown.
				return { runtime: "unknown" as const, terminal: false };
			}
		},
		probeSandboxCr: async (cand) => {
			const name = (cand.runtimeSandboxName ?? "").trim();
			// No CR name ⇒ we can't prove the CR is gone → unknown (never converge on
			// it). A genuinely never-provisioned row (no name AND no app-id) is caught
			// by the pure decider's never_provisioned branch before any probe.
			if (!name) return "unknown";
			try {
				const cr = await getKubernetesSandbox(name);
				return cr ? "present" : "absent";
			} catch {
				return "unknown";
			}
		},
		probePod: async (cand) => {
			const appId = (cand.runtimeAppId ?? "").trim();
			if (!appId) return { state: "unknown", exited: false };
			// Phase-aware tri-state probe: counts a Pending pod as present, flags an
			// EXITED pod (terminal phase — the stranded-host signal), and maps a kube
			// API failure to `unknown` (NOT `absent`) — a transient error is not
			// proof the pod is gone.
			const status = await getSessionRuntimePodStatus({ runtimeAppId: appId });
			return { state: status.presence, exited: status.exited };
		},
		countRescueAttempts: async (sessionId) =>
			countEventsByType(sessionId, "session.host_rescued"),
		rescueStrandedHost: async (cand, attempt) => {
			const appId = (cand.runtimeAppId ?? "").trim();
			if (!appId) return;
			// Delete only EXITED pods; the Sandbox controller (CR still present,
			// spec.replicas=1) recreates the host and the durabletask worker resumes
			// the session's durable workflow via replay. Verified live 2026-07-07.
			const deleted = await deleteSessionRuntimeExitedPods({ runtimeAppId: appId });
			// Per-attempt idempotent marker — this is what countRescueAttempts counts,
			// so retried ticks with an unchanged attempt index never double-count.
			await appendSessionEvent(cand.id, {
				type: "session.host_rescued",
				data: {
					source: "session_liveness_reconciler",
					attempt,
					deletedPods: deleted,
					sandboxName: cand.runtimeSandboxName,
					reason: "pod_exited_session_live",
				},
				processedAt: null,
				sourceEventId: `host-rescue:${cand.id}:${attempt}`,
			});
			console.info(
				`[session-reconciler] rescued stranded host for ${cand.id}: deleted exited pod(s) ${deleted.join(", ") || "(none found)"} (attempt ${attempt + 1})`,
			);
		},
		now: () => Date.now(),
		appendAudit: async (sessionId, data) => {
			// Dedupe per SILENCE EPISODE: key the sourceEventId on the session's
			// last_event_at value so a recurring warn fires ONCE per episode and
			// re-arms only when new events arrive (lastEventAt advances → new key).
			// Idempotent on (session_id, source_event_id). Converge/finalize rows get
			// completedAt and leave the candidate set, so they never re-emit.
			const episode = data.lastEventAt ?? "none";
			await appendSessionEvent(sessionId, {
				type: "session.reconciler_action",
				data: { ...data, source: "session_liveness_reconciler" },
				processedAt: null,
				sourceEventId: `reconciler:${sessionId}:${data.action}:${episode}`,
			});
		},
		confirmStop: async (sessionId) => {
			await confirmDurableStop({ kind: "session", id: sessionId });
		},
		convergeCrashed: async (sessionId, reason) => {
			await convergeCrashedSession({ kind: "session", id: sessionId }, { reason });
		},
		cleanupWorkspace: async (cand) => {
			await cleanupSessionSandbox(cand.daprInstanceId ?? cand.id);
		},
		maybeAutoResume: async (cand: LivenessReconcileCandidateRecord) =>
			maybeAutoResumeSession(
				{
					id: cand.id,
					agentId: cand.agentId,
					agentVersion: cand.agentVersion,
					userId: cand.userId,
					projectId: cand.projectId,
					title: cand.title,
					resumedFromSessionId: cand.resumedFromSessionId,
				},
				autoResumeDeps,
			),
	};
}

export const RECONCILER_JOB_NAME = "session-liveness-reconcile";

/**
 * Schedule the recurring liveness-reconcile job on the BFF's own Dapr sidecar
 * (Dapr Jobs API — durable, etcd-backed, replica-deduplicated, so exactly one
 * tick per interval fires across replicas and it survives a BFF restart). The
 * Scheduler upserts by name so re-scheduling on every replica's boot is
 * idempotent. Env-gated: no-op unless enabled AND SESSION_RECONCILER_TICK=dapr-job.
 *
 * The job `data` carries INTERNAL_API_TOKEN — Dapr delivers `data` back to the
 * `POST /job/<name>` callback, which is otherwise an unauthenticated endpoint, so
 * the token authenticates the callback (see `authenticateReconcilerJobPayload`).
 *
 * Runs a bounded BACKGROUND retry (daprd may not be ready at boot); callers
 * fire-and-forget it so it never blocks request readiness. A total failure is
 * logged loudly — the CronJob fallback + the internal route still work.
 */
export async function scheduleSessionReconcilerJob(): Promise<void> {
	const cfg = readReconcilerConfig();
	if (!cfg.enabled || cfg.tick !== "dapr-job") {
		console.log(
			`[session-reconciler] Dapr Job not scheduled (enabled=${cfg.enabled} tick=${cfg.tick})`,
		);
		return;
	}
	const token = readEnv("INTERNAL_API_TOKEN");
	const body = JSON.stringify({
		schedule: "@every 10m",
		dueTime: "2m",
		data: { reconcile: true, ...(token ? { token } : {}) },
	});
	const attempts = 5;
	const spacingMs = 20_000;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const res = await daprFetch(`${getDaprSidecarUrl()}/v1.0/jobs/${RECONCILER_JOB_NAME}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
				maxRetries: 0,
				signal: AbortSignal.timeout(5_000),
			});
			if (res.ok) {
				console.log(
					`[session-reconciler] scheduled Dapr Job '${RECONCILER_JOB_NAME}' (@every 10m)`,
				);
				return;
			}
			console.warn(
				`[session-reconciler] Dapr Job schedule non-OK ${res.status} (attempt ${attempt}/${attempts}): ${(
					await res.text().catch(() => "")
				).slice(0, 200)}`,
			);
		} catch (err) {
			console.warn(
				`[session-reconciler] Dapr Job schedule attempt ${attempt}/${attempts} failed:`,
				err instanceof Error ? err.message : err,
			);
		}
		if (attempt < attempts) {
			await new Promise((resolve) => setTimeout(resolve, spacingMs));
		}
	}
	console.error(
		`[session-reconciler] Dapr Job schedule FAILED after ${attempts} attempts — the reconciler will NOT tick on this pod via Dapr Jobs. Check daprd/Scheduler health, or set SESSION_RECONCILER_TICK=cronjob for the K8s CronJob fallback.`,
	);
}

/**
 * Authenticate a Dapr Job callback by the token carried in its delivered payload
 * (constant-time). Dapr wraps the job `data` differently across versions, so we
 * look in the common locations. When no INTERNAL_API_TOKEN is configured there is
 * no secret to enforce (dev) → allow.
 */
export function authenticateReconcilerJobPayload(body: unknown): boolean {
	const expected = readEnv("INTERNAL_API_TOKEN");
	if (!expected) return true;
	const record = (body ?? {}) as Record<string, unknown>;
	const data = (record.data ?? {}) as Record<string, unknown>;
	const candidate =
		(typeof record.token === "string" && record.token) ||
		(typeof data.token === "string" && data.token) ||
		"";
	if (!candidate) return false;
	const a = Buffer.from(candidate);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

export type RunSessionReconcileResult = ReconcileRunResult & { skipped?: string };

/**
 * The single reconcile entry both tick surfaces call. Reads env config, applies
 * any per-call overrides (the internal route accepts `{dryRun?, limit?}`), and
 * runs the sweep. No-ops (skipped:"disabled") when SESSION_RECONCILER_ENABLED=false.
 */
export async function runSessionReconcile(
	overrides: Partial<Pick<ReconcileOptions, "dryRun" | "limit">> = {},
): Promise<RunSessionReconcileResult> {
	const cfg = readReconcilerConfig();
	if (!cfg.enabled) {
		return { scanned: 0, decisions: [], actionsTaken: 0, dryRun: true, skipped: "disabled" };
	}
	const opts: ReconcileOptions = {
		dryRun: overrides.dryRun ?? cfg.dryRun,
		limit: Math.max(1, Math.min(200, overrides.limit ?? cfg.scanLimit)),
		minAgeSeconds: cfg.minAgeSeconds,
		silentWarnSeconds: cfg.silentWarnSeconds,
		maxActionsPerRun: cfg.maxActionsPerRun,
		autoResume: cfg.autoResume,
		maxRescuesPerSession: cfg.maxRescuesPerSession,
	};
	return reconcileSessions(createSessionReconcilerDeps(), opts);
}

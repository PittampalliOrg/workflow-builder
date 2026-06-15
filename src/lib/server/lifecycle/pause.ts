/**
 * Pause / Resume — reversible hold of a durable run, distinct from Stop.
 *
 * Pause maps to Dapr's native `suspend_workflow` (state `SUSPENDED`: alive,
 * non-terminal, resumable) — NOT `terminate`/`purge` (which end the run). The
 * runtimes already expose `POST /api/v2/agent-runs/{id}/{pause,resume}` →
 * `DaprWorkflowClient().suspend_workflow()/resume_workflow()`; this drives them
 * for a user-owned SESSION (resolved to its per-session runtime app-id) and
 * mirrors the hold into the DB (`status='paused'` + `pauseRequestedAt`) so the
 * UI can render it and the terminal reaper skips it.
 *
 * `applyPauseResume` is the deps-injected core (unit-tested); `pauseDurableRun`/
 * `resumeDurableRun` wire the real Dapr-invoke + DB-write deps. Symmetric with
 * `stopDurableRun` (lifecycle/index.ts): routes stay thin, the DB write lives here.
 */
import { daprFetch, getDaprSidecarUrl } from "$lib/server/dapr-client";
import { updateSessionStatus } from "$lib/server/sessions/registry";
import type { SessionStatus } from "$lib/types/sessions";
import type { AgentRuntimeTarget } from "./cascade";
import {
	type DurableRunTarget,
	type DurableTargetScope,
	type ResolvedDurableTarget,
	resolveDurableTarget,
} from "./resolvers";

export type PauseResumeResult = {
	/** The suspend/resume was applied to at least one runtime instance. */
	ok: boolean;
	notFound: boolean;
	scope: DurableTargetScope | null;
	/** Set when !ok — a short machine reason for the 4xx/409 mapping. */
	reason?: string;
};

export type PauseResumeVerb = "pause" | "resume";

export type PauseResumeDeps = {
	resolve: (target: DurableRunTarget) => Promise<ResolvedDurableTarget>;
	/** Invoke the per-session runtime's pause|resume endpoint; true on success. */
	invoke: (t: AgentRuntimeTarget, verb: PauseResumeVerb) => Promise<boolean>;
	/** Mirror the hold into the session row (status + pause-intent timestamp). */
	setSessionStatus: (
		sessionId: string,
		status: SessionStatus,
		pauseRequestedAt: Date | null,
	) => Promise<void>;
};

const CONTROL_TIMEOUT_MS = 20_000;

/**
 * Invoke a per-session runtime's pause|resume endpoint via Dapr service-invoke
 * (mirrors cascade.terminateAgentRuntime). Returns true on a 2xx.
 */
async function invokeAgentRuntimeControl(
	t: AgentRuntimeTarget,
	verb: PauseResumeVerb,
): Promise<boolean> {
	try {
		const res = await daprFetch(
			`${getDaprSidecarUrl()}/v1.0/invoke/${encodeURIComponent(t.runtimeAppId)}/method/api/v2/agent-runs/${encodeURIComponent(t.instanceId)}/${verb}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				maxRetries: 0,
				signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
			},
		);
		return res.ok;
	} catch {
		return false;
	}
}

/**
 * Deps-injected core. Pause requires the run to still be active; both verbs
 * require at least one runtime instance to confirm before the DB is mirrored —
 * so the row never disagrees with the actual workflow state.
 */
export async function applyPauseResume(
	target: DurableRunTarget,
	verb: PauseResumeVerb,
	deps: PauseResumeDeps,
): Promise<PauseResumeResult> {
	const resolved = await deps.resolve(target);
	if (resolved.notFound) return { ok: false, notFound: true, scope: null };
	if (verb === "pause" && !resolved.dbActive) {
		return { ok: false, notFound: false, scope: resolved.scope, reason: "not_active" };
	}
	const targets = resolved.agentRuntimeTargets;
	if (targets.length === 0) {
		return { ok: false, notFound: false, scope: resolved.scope, reason: "no_runtime" };
	}
	const results = await Promise.all(targets.map((t) => deps.invoke(t, verb)));
	if (!results.some(Boolean)) {
		return {
			ok: false,
			notFound: false,
			scope: resolved.scope,
			reason: verb === "pause" ? "suspend_failed" : "resume_failed",
		};
	}
	if (target.kind === "session") {
		try {
			await deps.setSessionStatus(
				target.id,
				verb === "pause" ? "paused" : "running",
				verb === "pause" ? new Date() : null,
			);
		} catch {
			/* best-effort DB mirror; the Dapr suspend/resume is the source of truth */
		}
	}
	return { ok: true, notFound: false, scope: resolved.scope };
}

const realDeps: PauseResumeDeps = {
	resolve: resolveDurableTarget,
	invoke: invokeAgentRuntimeControl,
	setSessionStatus: (id, status, pauseRequestedAt) =>
		updateSessionStatus(id, status, { pauseRequestedAt }),
};

/** Pause (suspend) a still-active durable run. */
export function pauseDurableRun(target: DurableRunTarget): Promise<PauseResumeResult> {
	return applyPauseResume(target, "pause", realDeps);
}

/** Resume (un-suspend) a paused run. */
export function resumeDurableRun(target: DurableRunTarget): Promise<PauseResumeResult> {
	return applyPauseResume(target, "resume", realDeps);
}

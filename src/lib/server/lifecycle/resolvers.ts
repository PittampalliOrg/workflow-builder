/**
 * Per-target-kind resolution for the lifecycle controller.
 *
 * A resolver turns a high-level {@link DurableRunTarget} into the concrete
 * Dapr/K8s/DB handles the generic cascade needs: the parent orchestrator
 * instance(s), the per-session agent-runtime workflow instances (each under its
 * own app-id), the Sandbox CR names to reap, the extra instance ids for raw
 * state-row purge, the auth scope, whether the run is still active, and a
 * `finalizeDb` callback that flips the owning rows terminal once the durable tree is
 * confirmed closed.
 *
 * This file is intentionally infrastructure-free. The production Drizzle-backed
 * implementation lives in
 * `src/lib/server/application/adapters/lifecycle-resolver.ts`.
 */
import { createHash } from "node:crypto";
import type { AgentRuntimeTarget } from "./cascade";

export type DurableRunTarget =
	| { kind: "workflowExecution"; id: string }
	| { kind: "session"; id: string }
	| { kind: "evalRun"; id: string };

export type DurableTargetScope = { projectId: string | null; userId: string };

export type ResolvedDurableTarget = {
	notFound: boolean;
	/** DB row indicates a non-terminal (still-running) durable run. */
	dbActive: boolean;
	/**
	 * When the durable stop-intent was persisted (stop_requested_at /
	 * cancel_requested_at), or null if no stop has been requested. Lets the
	 * controller grace-gate the cross-app child wedge finalize — we only
	 * force-clean a parent that's been asked to stop and stayed wedged.
	 */
	stopRequestedAt: Date | null;
	scope: DurableTargetScope | null;
	parentInstanceIds: string[];
	agentRuntimeTargets: AgentRuntimeTarget[];
	/** Per-session Sandbox CR names to delete on purge/reset. */
	sandboxNames: string[];
	statePurgeInstanceIds: string[];
	/** Flip owning DB rows terminal. Only invoked once the cascade confirms closure. */
	finalizeDb: (reason: string) => Promise<void>;
	/**
	 * Node ids of `durable/run` child sessions that are DB-`terminated`. Used to
	 * confirm a cross-app wedge with POSITIVE evidence: only force-finalize when
	 * the parent's live `currentNodeId` is one of these (the parent is genuinely
	 * parked at a durable/run node whose agent child is gone) — not when a
	 * still-booting sandbox merely 404s, nor when the parent has moved on to a
	 * later non-agent node. Empty for session/eval targets (no cross-app wedge).
	 */
	terminatedChildNodes: string[];
	/**
	 * Node ids that still have ≥1 NON-terminated child session. Used by the
	 * cross-app wedge check to refuse force-finalizing a `for`/loop node while one
	 * of its iterations is still running (loop-prefix match safety guard). Empty
	 * for session/eval targets.
	 */
	activeChildNodes: string[];
	/**
	 * Stamp the durable stop-intent (stop_requested_at) the moment a stop is
	 * requested — BEFORE the cascade confirms closure. Keeps the row non-terminal
	 * but marks it so the UI shows "Stopping…" and the terminal-status reaper can
	 * finalize it later if the in-request poll window expires. Idempotent.
	 */
	markStopRequested: (reason: string) => Promise<void>;
};

export type LifecycleTargetResolver = (
	target: DurableRunTarget,
) => Promise<ResolvedDurableTarget>;

/** Per-session agent-runtime app-id — mirrors agent-workflow-host.ts:sessionHostAppId. */
export function sessionHostAppId(sessionId: string): string | null {
	const normalized = sessionId.trim();
	if (!normalized) return null;
	return `agent-session-${createHash("sha256").update(normalized).digest("hex").slice(0, 20)}`;
}

export function notFoundLifecycleTarget(): ResolvedDurableTarget {
	return {
		notFound: true,
		dbActive: false,
		stopRequestedAt: null,
		terminatedChildNodes: [],
		activeChildNodes: [],
		scope: null,
		parentInstanceIds: [],
		agentRuntimeTargets: [],
		sandboxNames: [],
		statePurgeInstanceIds: [],
		finalizeDb: async () => {},
		markStopRequested: async () => {},
	};
}

export function compactLifecycleIds(values: Array<string | null | undefined>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const v of values) {
		const t = (v ?? "").trim();
		if (t && !seen.has(t)) {
			seen.add(t);
			out.push(t);
		}
	}
	return out;
}

/**
 * Extract the SW node id from a workflow-driven child session id
 * (`<exec>__<instancePrefix>__<node>__run__<idx>`). The instance prefix is the
 * PER-RUNTIME registry value (runtime-registry.json): `durable` (dapr-agent-py)
 * OR `durable-<suffix>` for every other runtime — `durable-claude`,
 * `durable-adk`, `durable-browser-use`, `durable-claude-cli`, `durable-codex-cli`,
 * `durable-agy-cli`, `durable-testing`. The optional `-<suffix>` is REQUIRED in the
 * pattern: hardcoding bare `durable` left `terminatedChildNodes` empty for the 7
 * non-default runtimes, so the cross-app wedge force-finalize never fired for them
 * (a Stopped claude/adk/browser/CLI durable run polled "stopping" forever).
 */
export function nodeIdFromChildSessionId(sessionId: string): string | null {
	const m = sessionId.match(/__durable(?:-[a-z0-9-]+)?__(.+?)__run__\d+/);
	return m ? m[1] : null;
}

export function agentTargetForSession(row: {
	id: string;
	daprInstanceId: string | null;
	runtimeAppId: string | null;
	runtimeSandboxName?: string | null;
}): AgentRuntimeTarget | null {
	const instanceId = (row.daprInstanceId ?? row.id ?? "").trim();
	let runtimeAppId = (row.runtimeAppId ?? "").trim();
	if (!runtimeAppId) {
		// Only SYNTHESIZE the deterministic per-session app-id when there's evidence
		// the session actually runs on a per-session sandbox (its CR name is set, or
		// its written app-id already maps that way). For a session with no app-id AND
		// no sandbox (not started yet, or a pool-hosted/legacy agent under a shared
		// app-id), the derivation would be WRONG — terminate would hit a nonexistent
		// instance (benign-miss → "alreadyGone") and the cascade would falsely report
		// the agent closed. Leave it unresolved instead so the stop reports "stopping"
		// and the reaper retries once the real linkage is written.
		if ((row.runtimeSandboxName ?? "").trim()) {
			runtimeAppId = (sessionHostAppId(row.id) ?? "").trim();
		}
	}
	if (!instanceId || !runtimeAppId) return null;
	return { runtimeAppId, instanceId };
}

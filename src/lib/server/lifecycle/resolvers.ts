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
import { sessionRuntimeGenerationInstanceId } from "$lib/server/application/session-runtime-identity";
import type { AgentRuntimeTarget } from "./cascade";

export { sessionRuntimeGenerationInstanceId } from "$lib/server/application/session-runtime-identity";

export type DurableRunTarget =
	| { kind: "workflowExecution"; id: string }
	| { kind: "session"; id: string }
	| { kind: "evalRun"; id: string };

export type DurableTargetScope = { projectId: string | null; userId: string };

/**
 * Terminal shape a `finalizeDb` closure should write. `terminated` is the normal
 * user/stop-driven end; `crashed` is set by the liveness reconciler when it
 * converges a dead session (→ row `failed` + stopReason:{type:"crashed"}).
 */
export type FinalizeOutcome = "terminated" | "crashed";

/** Destructive terminal modes persisted with a durable stop intent. */
export type DurableStopMode = "terminate" | "purge" | "reset";

export type PersistedStopIntent = {
  requestedAt: Date;
  mode: DurableStopMode;
};

/** Stable execution identity understood by a retained-workspace provider. */
export type WorkspaceRetentionIdentity = {
  durableExecutionId: string;
  databaseExecutionId: string | null;
};

/**
 * Durable evidence that a session runtime create may still be in flight. The
 * prospective target is generation-specific, so lifecycle can control it without
 * replacing the last authoritative runtime target stored on the session row.
 */
export type RuntimeProvisioningLease = {
  sessionId: string;
  startedAt: Date;
  prospectiveTarget: AgentRuntimeTarget;
};

export type FinalizeDbResult = "finalized" | "mode_changed";

/** Invalid/legacy persisted values always degrade to the least destructive mode. */
export function normalizeDurableStopMode(value: unknown): DurableStopMode {
  return value === "purge" || value === "reset" || value === "terminate"
    ? value
    : "terminate";
}

export type ResolvedDurableTarget = {
	notFound: boolean;
	/** DB row indicates a non-terminal (still-running) durable run. */
	dbActive: boolean;
	/**
	 * Raw DB status string of the resolved row (session/exec/eval). Distinct from
	 * `dbActive`: a `failed` session is still `dbActive` (its pod may be alive, so
	 * Stop/archive gating must still treat it as live) but is NOT a valid pause
	 * target. Populated for sessions; optional/omitted where a verb doesn't need it.
	 */
	dbStatus?: string | null;
	/**
	 * When the durable stop-intent was persisted (stop_requested_at /
	 * cancel_requested_at), or null if no stop has been requested. Lets the
	 * controller grace-gate the cross-app child wedge finalize — we only
	 * force-clean a parent that's been asked to stop and stayed wedged.
	 */
	stopRequestedAt: Date | null;
  /** Persisted monotonic terminal stop mode; null on legacy intents. */
  stopRequestedMode: DurableStopMode | null;
	scope: DurableTargetScope | null;
	parentInstanceIds: string[];
	agentRuntimeTargets: AgentRuntimeTarget[];
  /** Active, independently aged provisioning leases for this target's sessions. */
  runtimeProvisioningLeases: RuntimeProvisioningLease[];
  /**
   * Acknowledge one exact stopped lease after its generation-specific runtime
   * has been purged and deleted. The adapter must reject a newer lease.
   */
  acknowledgeRuntimeProvisioningCompensation: (
    sessionId: string,
    expectedStartedAt: Date,
  ) => Promise<boolean>;
  /**
   * Active session rows whose runtime linkage has not been persisted yet. These
   * are common during eager provisioning: the session exists before its
   * runtime_app_id / runtime_sandbox_name write completes. An unresolved link is
   * uncertainty, never proof that the runtime is absent, so lifecycle callers
   * must remain `stopping` and let the reconciler retry after provisioning
   * publishes the linkage.
   */
  unresolvedRuntimeLinkages: string[];
  /** Per-session agent-host Kubernetes Sandbox CR names to delete on terminal stop. */
	sandboxNames: string[];
  /** Per-session OpenShell Sandbox names owned by this durable target. */
  workspaceSandboxNames: string[];
  /** Typed provider identities for retained OpenShell workspace discovery. */
  workspaceRetentionIdentities: WorkspaceRetentionIdentity[];
  /** Workflow-scoped OpenShell executions cleaned only by purge/reset. */
  workspaceCleanupExecutionIds: string[];
	statePurgeInstanceIds: string[];
	/**
	 * Flip owning DB rows terminal. Only invoked once the cascade confirms closure.
	 * `outcome` selects the terminal shape (default `terminated`): the session
	 * liveness reconciler passes `crashed` so a converged dead/orphaned session
	 * lands `failed` + stopReason:{type:"crashed"} instead of `terminated`. Only
	 * the session resolver honors `crashed`; workflow/eval resolvers ignore it.
	 */
  finalizeDb: (
    reason: string,
    outcome?: FinalizeOutcome,
    /**
     * Compare-and-acknowledge fence for a persisted stop. The adapter clears the
     * pending stop intent only when this mode is still authoritative; a stronger
     * concurrent request returns `mode_changed` and remains eligible for redrive.
     * Omit only when repairing a terminal-runtime/DB projection divergence that
     * has no stop intent.
     */
    expectedMode?: DurableStopMode,
  ) => Promise<FinalizeDbResult>;
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
	 * but marks it so the UI shows "Stopping…" and the status confirmation path can
	 * finalize it later if the in-request poll window expires. Idempotent.
	 */
  markStopRequested: (
    reason: string,
    mode: DurableStopMode,
  ) => Promise<PersistedStopIntent>;
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

/**
 * Immutable app-id for one provisioning generation. Including the lease token
 * prevents a late creator or cleanup from touching a replacement generation.
 */
export function sessionRuntimeGenerationAppId(
  sessionId: string,
  provisioningStartedAt: Date,
): string | null {
  const normalized = sessionId.trim();
  if (!normalized || !Number.isFinite(provisioningStartedAt.getTime())) {
    return null;
  }
  const identity = `${normalized}\0${provisioningStartedAt.toISOString()}`;
  return `agent-session-${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
}

export function notFoundLifecycleTarget(): ResolvedDurableTarget {
	return {
		notFound: true,
		dbActive: false,
		dbStatus: null,
		stopRequestedAt: null,
    stopRequestedMode: null,
		terminatedChildNodes: [],
		activeChildNodes: [],
		scope: null,
		parentInstanceIds: [],
		agentRuntimeTargets: [],
    runtimeProvisioningLeases: [],
    acknowledgeRuntimeProvisioningCompensation: async () => false,
    unresolvedRuntimeLinkages: [],
		sandboxNames: [],
    workspaceSandboxNames: [],
    workspaceRetentionIdentities: [],
    workspaceCleanupExecutionIds: [],
		statePurgeInstanceIds: [],
    finalizeDb: async () => "finalized",
    markStopRequested: async (_reason, mode) => ({
      requestedAt: new Date(0),
      mode,
    }),
	};
}

export function compactLifecycleIds(
  values: Array<string | null | undefined>,
): string[] {
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
  runtimeHostOwned?: boolean | null;
}): AgentRuntimeTarget | null {
	const instanceId = (row.daprInstanceId ?? row.id ?? "").trim();
	let runtimeAppId = (row.runtimeAppId ?? "").trim();
  let runtimeSandboxName = (row.runtimeSandboxName ?? "").trim() || null;
  // Every `agent-session-*` app id is a deterministic, per-session direct host.
  // Older/provisioning rows can have the app id persisted before the Sandbox CR
  // name; retain direct routing by deriving the controller's canonical name.
  if (!runtimeSandboxName && runtimeAppId.startsWith("agent-session-")) {
    runtimeSandboxName = `agent-host-${runtimeAppId}`;
  }
	if (!runtimeAppId) {
		// Only SYNTHESIZE the deterministic per-session app-id when there's evidence
		// the session actually runs on a per-session sandbox (its CR name is set, or
		// its written app-id already maps that way). For a session with no app-id AND
		// no sandbox (not started yet, or a pool-hosted/legacy agent under a shared
		// app-id), the derivation would be WRONG — terminate would hit a nonexistent
		// instance (benign-miss → "alreadyGone") and the cascade would falsely report
		// the agent closed. Leave it unresolved instead so the stop reports "stopping"
		// and a later explicit status confirmation retries once the real linkage is
		// written.
    if (runtimeSandboxName) {
			runtimeAppId = (sessionHostAppId(row.id) ?? "").trim();
		}
	}
	if (!instanceId || !runtimeAppId) return null;
  return {
    runtimeAppId,
    instanceId,
    runtimeSandboxName,
    ...(row.runtimeHostOwned === false ? { ownsRuntimeSandbox: false } : {}),
  };
}

/**
 * Script-authored teams use an idle session row as their lead identity and
 * mailbox anchor. That row intentionally has no durable agent runtime, so it
 * must not enter the runtime-publication grace used by real agent sessions.
 * If runtime identity is ever attached, treat the row as runtime-backed so a
 * corrupted or migrated row is still cleaned conservatively.
 */
export function sessionRequiresRuntimeLinkage(row: {
  agentId?: string | null;
  status?: string | null;
  daprInstanceId?: string | null;
  runtimeAppId?: string | null;
  runtimeSandboxName?: string | null;
}): boolean {
  const runtimeLessScriptLead =
    row.agentId === "script-team-lead" &&
    row.status === "idle" &&
    !(row.daprInstanceId ?? "").trim() &&
    !(row.runtimeAppId ?? "").trim() &&
    !(row.runtimeSandboxName ?? "").trim();
  return !runtimeLessScriptLead;
}

export function prospectiveAgentTargetForSession(row: {
  id: string;
  daprInstanceId: string | null;
  runtimeProvisioningStartedAt?: Date | null;
  runtimeProvisioningAppId?: string | null;
  runtimeProvisioningInstanceId?: string | null;
  runtimeProvisioningSandboxName?: string | null;
  runtimeProvisioningHostOwned?: boolean | null;
}): AgentRuntimeTarget | null {
  if (!row.runtimeProvisioningStartedAt) return null;
  const stagedAppId = (row.runtimeProvisioningAppId ?? "").trim();
  const stagedInstanceId = (row.runtimeProvisioningInstanceId ?? "").trim();
  const stagedSandboxName =
    (row.runtimeProvisioningSandboxName ?? "").trim() || null;
  const hasStagedFields =
    stagedAppId.length > 0 ||
    stagedInstanceId.length > 0 ||
    stagedSandboxName !== null ||
    row.runtimeProvisioningHostOwned != null;
  if (hasStagedFields) {
    if (
      !stagedAppId ||
      !stagedInstanceId ||
      row.runtimeProvisioningHostOwned == null
    ) {
      return null;
    }
    return {
      runtimeAppId: stagedAppId,
      instanceId: stagedInstanceId,
      runtimeSandboxName: stagedSandboxName,
      ...(row.runtimeProvisioningHostOwned
        ? {}
        : { ownsRuntimeSandbox: false }),
    };
  }

  // Backward compatibility for timestamp-only leases created before exact
  // staging existed. Those launches always used the dedicated generation id.
  const instanceId = sessionRuntimeGenerationInstanceId(
    row.id,
    row.runtimeProvisioningStartedAt,
  );
  const runtimeAppId = sessionRuntimeGenerationAppId(
    row.id,
    row.runtimeProvisioningStartedAt,
  );
  if (!instanceId || !runtimeAppId) return null;
  return {
    runtimeAppId,
    instanceId,
    runtimeSandboxName: `agent-host-${runtimeAppId}`,
  };
}

/** Authoritative persisted target plus the generation-specific in-flight target. */
export function agentTargetsForSession(row: {
  id: string;
  daprInstanceId: string | null;
  runtimeAppId: string | null;
  runtimeSandboxName?: string | null;
  runtimeHostOwned?: boolean | null;
  runtimeProvisioningStartedAt?: Date | null;
  runtimeProvisioningAppId?: string | null;
  runtimeProvisioningInstanceId?: string | null;
  runtimeProvisioningSandboxName?: string | null;
  runtimeProvisioningHostOwned?: boolean | null;
}): AgentRuntimeTarget[] {
  const candidates = [agentTargetForSession(row)];
  if (row.runtimeProvisioningStartedAt) {
    candidates.push(prospectiveAgentTargetForSession(row));
  }
  const seen = new Set<string>();
  return candidates.filter((candidate): candidate is AgentRuntimeTarget => {
    if (!candidate) return false;
    const key = [
      candidate.runtimeAppId.trim(),
      candidate.instanceId.trim(),
      candidate.runtimeSandboxName?.trim() ?? "",
      candidate.ownsRuntimeSandbox === false ? "borrowed" : "owned",
    ].join("\u0000");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

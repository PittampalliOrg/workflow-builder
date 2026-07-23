/**
 * The vetted lifecycle controller.
 *
 * `stopDurableRun` is the single server-side entry point for stopping any
 * durable run (a workflow execution, an agent session, or an evaluation run)
 * and — for purge/reset — leaving nothing behind that breaks the next run. It
 * is fail-closed: it only flips DB rows terminal / reaps sandboxes once the
 * durable tree is confirmed closed, and otherwise reports `confirmed:false` so
 * callers can return HTTP 202 "stopping" while the stop/status confirmation path
 * converges.
 *
 * Every user-facing "stop" surface should route through this. See
 * docs/workflow-lifecycle-termination.md.
 */
import { env } from "$env/dynamic/private";
import { createDaprCascadeDeps } from "$lib/server/application/adapters/lifecycle-cascade";
import { resolveDurableTarget } from "$lib/server/application/adapters/lifecycle-resolver";
import { configuredWorkspaceRetentionPort } from "$lib/server/application/adapters/workspace-retention-http";
import { raiseSessionEvent } from "$lib/server/sessions/control";
import {
	DURABLE_RUNTIME_MISSING_STATUS,
	type DurableCascadeResult,
	isBenignDaprPurgeMiss,
	isTerminalDurableRuntimeStatus,
	runDurableCascade,
	shouldForceFinalizeCrossAppWedge,
} from "./cascade";
import {
  type DurableStopMode,
	type DurableRunTarget,
	type DurableTargetScope,
	type FinalizeOutcome,
  normalizeDurableStopMode,
  type PersistedStopIntent,
} from "./resolvers";

export type { DurableRunTarget, DurableTargetScope } from "./resolvers";

export type StopDurableRunMode =
	/** Cooperative pause: ask the agent to halt at a safe boundary. No purge, no DB flip, no reap. */
	| "interrupt"
	/** Terminate the durable tree (graceful then forceful). No purge. */
	| "terminate"
	/** Terminate + purge durable state + reap Sandbox CRs + flip DB terminal. */
	| "purge"
	/**
	 * purge + force-delete state rows even if Dapr never confirmed terminal — the
	 * "byte-clean" re-run mode (the UI "Stop & reset"). This IS reachable by
	 * normal users (it's a per-run dev affordance), and that is safe because every
	 * stop route runs `isResourceInScope` before `stopDurableRun`, so the
	 * force-delete only touches the caller's own in-scope run, and the state-row
	 * purge is boundary-anchored (no sibling over-delete). It does not require
	 * admin — the audit's "gate to admin" suggestion would break Stop & reset.
	 */
	| "reset";

export type StopDurableRunStep = {
	name: string;
	result: "ok" | "skipped" | "failed" | "partial";
	detail?: string;
};

export type StopDurableRunOptions = {
	mode: StopDurableRunMode;
	reason?: string;
	/** Graceful cooperative-cancel wait before forceful terminate (ms). 0 = skip graceful. */
	graceMs?: number;
	/**
	 * Terminal shape the DB finalize writes (default `terminated`). The liveness
	 * reconciler passes `crashed` (via {@link convergeCrashedSession}) so a
	 * converged session lands `failed` + stopReason `crashed` instead of
	 * `terminated`. Only honored on the purge/reset finalize path.
	 */
	finalizeOutcome?: FinalizeOutcome;
};

export type StopDurableRunResult = {
	confirmed: boolean;
	notFound: boolean;
	/** True once the durable stop-intent was persisted (terminate/purge/reset). */
	requested: boolean;
	/**
	 * confirmed — durable tree terminal AND DB finalized/sandboxes reaped.
	 * stopping — stop requested + intent persisted, converging asynchronously
	 *   (the in-request poll window expired or finalize is pending); a status poll
	 *   will finalize once Dapr is terminal. Maps to HTTP 202.
	 * notFound — no such durable run.
	 */
	state: "confirmed" | "stopping" | "notFound";
	scope: DurableTargetScope | null;
	cascade?: DurableCascadeResult;
	/**
	 * Set when a cooperative interrupt couldn't be delivered for a TRANSIENT reason
	 * (the session is live but the runtime raise hiccuped, e.g. a 5xx/flaky
	 * sidecar) — as opposed to "not running yet". Lets the route map it to a
	 * retryable 503 instead of a misleading 409.
	 */
	retryable?: boolean;
	steps: StopDurableRunStep[];
};

// One shared deps instance — generic Dapr-backed orchestrator + agent-runtime ops.
// Timing is env-tunable: the in-request poll window cannot fully cover a workflow
// blocked in a long activity (terminate applies only when the activity yields), so
// operators can widen it; the persisted stop-intent + explicit stop/status
// confirmation path converge the tail.
function envSeconds(
  name: string,
  fallbackS: number,
  minS: number,
  maxS: number,
): number {
	const raw = env[name] ?? process.env[name];
	const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
	const s = Number.isFinite(n) ? n : fallbackS;
	return Math.max(minS, Math.min(maxS, s)) * 1000;
}
const cascadeDeps = createDaprCascadeDeps({
	waitMs: envSeconds("LIFECYCLE_CASCADE_WAIT_SECONDS", 90, 5, 1800),
	waitPollMs: envSeconds("LIFECYCLE_CASCADE_POLL_SECONDS", 1, 1, 30),
  requestTimeoutMs: envSeconds(
    "LIFECYCLE_CASCADE_REQUEST_TIMEOUT_SECONDS",
    20,
    1,
    120,
  ),
});
const workspaceRetention = configuredWorkspaceRetentionPort();

// Grace before confirmDurableStop force-finalizes the cross-app child wedge.
// The SW-interpreter parent runs a `durable/run` step via
// ctx.call_child_workflow(app_id=<per-session agent app-id>) — a cross-app-id
// sub-orchestration on a SEPARATE Dapr task hub. Dapr's recursive terminate is
// bounded to one task hub, so a bare terminate on the parent never applies while
// it awaits that child: the parent hangs RUNNING forever even though the cascade
// already terminated the child agent (no runaway compute — it's an idle zombie).
// Once the child is terminal/gone AND this grace has elapsed since the stop was
// requested (long enough for any normally-terminable parent to have applied the
// terminate the cascade issued), we force-delete the wedged parent's durable
// state rows directly — the same mechanism mode:"reset" uses. The grace is the
// safety that keeps us from force-cleaning a parent that's merely slow to
// terminate or legitimately progressing through a later same-task-hub node.
const WEDGE_FINALIZE_GRACE_MS = envSeconds(
	"LIFECYCLE_WEDGE_FINALIZE_GRACE_SECONDS",
	180,
	30,
	1800,
);

// A stop can race eager per-session host provisioning. The provisioner persists
// an independent lease before external creation; the resolver keeps the old
// authoritative target and also derives the deterministic prospective host.
// Each child lease gets its own bounded grace. A dead provisioner therefore
// expires from the time it started, rather than making a later stop wait again.
const PROVISIONING_STOP_GRACE_MS = envSeconds(
  "LIFECYCLE_PROVISIONING_STOP_GRACE_SECONDS",
  600,
  5,
  1800,
);

function unresolvedLinkageBlocks(
  resolved: Awaited<ReturnType<typeof resolveDurableTarget>>,
  requestedAt: Date | null,
): boolean {
  if (resolved.unresolvedRuntimeLinkages.length === 0) return false;
  const leaseBySession = new Map(
    resolved.runtimeProvisioningLeases.map((lease) => [
      lease.sessionId,
      lease.startedAt,
    ]),
  );
  return resolved.unresolvedRuntimeLinkages.some((sessionId) => {
    // Rows created by an older deployment have no explicit lease. Preserve the
    // rollout-safe behavior for those rows by aging them from the stop intent.
    const graceStartedAt = leaseBySession.get(sessionId) ?? requestedAt;
    if (!graceStartedAt) return true;
    return Date.now() - graceStartedAt.getTime() < PROVISIONING_STOP_GRACE_MS;
  });
}

function hasExactParentPurgeClosureEvidence(
  resolved: Awaited<ReturnType<typeof resolveDurableTarget>>,
): boolean {
  return (
    resolved.activeChildNodes.length === 0 &&
    resolved.unresolvedRuntimeLinkages.length === 0
  );
}

const STOP_MODE_PRIORITY: Record<DurableStopMode, number> = {
  terminate: 0,
  purge: 1,
  reset: 2,
};

function strongestStopMode(
  left: DurableStopMode,
  right: DurableStopMode | null,
): DurableStopMode {
  if (right == null) return left;
  return STOP_MODE_PRIORITY[right] > STOP_MODE_PRIORITY[left] ? right : left;
}

function ownedRuntimeSandboxTargets(
  resolved: Awaited<ReturnType<typeof resolveDurableTarget>>,
): Array<{ runtimeAppId: string; runtimeSandboxName: string }> {
  const targets = new Map<
    string,
    { runtimeAppId: string; runtimeSandboxName: string }
  >();
  for (const target of resolved.agentRuntimeTargets) {
    const runtimeAppId = target.runtimeAppId.trim();
    const runtimeSandboxName = target.runtimeSandboxName?.trim();
    if (!runtimeAppId || !runtimeSandboxName || target.ownsRuntimeSandbox === false) {
      continue;
    }
    targets.set(`${runtimeAppId}\u0000${runtimeSandboxName}`, {
      runtimeAppId,
      runtimeSandboxName,
    });
  }
  return [...targets.values()];
}

async function cleanupResolvedWorkspaces(
  resolved: Awaited<ReturnType<typeof resolveDurableTarget>>,
  includeExecutionScoped: boolean,
  onResult?: (name: string, ok: boolean, detail?: string) => void,
): Promise<boolean> {
  let cleanupOk = true;
  for (const name of resolved.workspaceSandboxNames) {
    try {
      if (!cascadeDeps.deleteWorkspaceSandbox) {
        throw new Error("named OpenShell Sandbox deletion is not configured");
      }
      await cascadeDeps.deleteWorkspaceSandbox(name);
      onResult?.(`cleanup-workspace-sandbox:${name}`, true);
    } catch (err) {
      cleanupOk = false;
      onResult?.(
        `cleanup-workspace-sandbox:${name}`,
        false,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  if (includeExecutionScoped) {
    for (const executionId of resolved.workspaceCleanupExecutionIds) {
      try {
        if (!cascadeDeps.cleanupWorkspaceExecution) {
          throw new Error(
            "execution-scoped OpenShell cleanup is not configured",
          );
        }
        await cascadeDeps.cleanupWorkspaceExecution(executionId);
        onResult?.(`cleanup-workspace-execution:${executionId}`, true);
      } catch (err) {
        cleanupOk = false;
        onResult?.(
          `cleanup-workspace-execution:${executionId}`,
          false,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }
  return cleanupOk;
}

async function retainOrCleanupResolvedWorkspaces(
  resolved: Awaited<ReturnType<typeof resolveDurableTarget>>,
  terminalAt: Date,
  onResult?: (name: string, ok: boolean, detail?: string) => void,
): Promise<boolean> {
  // Retention is an explicit provider capability. Clusters that have not
  // adopted it keep the established terminate cleanup behavior; once enabled,
  // the provider owns the first TTL transition and a failed acknowledgement
  // leaves the durable stop intent pending for confirmation retry.
  if (!workspaceRetention || resolved.workspaceRetentionIdentities.length === 0) {
    return cleanupResolvedWorkspaces(resolved, false, onResult);
  }

  let ok = true;
  for (const identity of resolved.workspaceRetentionIdentities) {
    const label =
      identity.databaseExecutionId || identity.durableExecutionId || "unknown";
    try {
      const acknowledgement = await workspaceRetention.armTerminalRetention({
        identity,
        terminalAt,
      });
      onResult?.(
        `arm-workspace-retention:${label}`,
        true,
        `results=${acknowledgement.resultCount}`,
      );
    } catch (err) {
      ok = false;
      onResult?.(
        `arm-workspace-retention:${label}`,
        false,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return ok;
}

async function acknowledgeResolvedProvisioningLeases(
	resolved: Awaited<ReturnType<typeof resolveDurableTarget>>,
	onResult?: (name: string, ok: boolean, detail?: string) => void,
): Promise<boolean> {
	let ok = true;
	for (const lease of resolved.runtimeProvisioningLeases) {
		try {
			const acknowledged =
				await resolved.acknowledgeRuntimeProvisioningCompensation(
					lease.sessionId,
					lease.startedAt,
				);
			if (!acknowledged) {
				ok = false;
				onResult?.(
					`ack-runtime-provisioning:${lease.sessionId}`,
					false,
					"lease generation changed; re-resolving before finalization",
				);
				continue;
			}
			onResult?.(`ack-runtime-provisioning:${lease.sessionId}`, true);
		} catch (err) {
			ok = false;
			onResult?.(
				`ack-runtime-provisioning:${lease.sessionId}`,
				false,
				err instanceof Error ? err.message : String(err),
			);
		}
	}
	return ok;
}

/**
 * Resolve a target's auth scope + whether its durable run is still active,
 * without performing any stop action. Used to enforce CMA scope and to block
 * destructive delete/archive while a run is live.
 */
export async function inspectDurableRun(target: DurableRunTarget): Promise<{
	notFound: boolean;
	active: boolean;
	scope: DurableTargetScope | null;
}> {
	const resolved = await resolveDurableTarget(target);
	return {
		notFound: resolved.notFound,
		active: !resolved.notFound && resolved.dbActive,
		scope: resolved.scope,
	};
}

export async function stopDurableRun(
	target: DurableRunTarget,
	opts: StopDurableRunOptions,
): Promise<StopDurableRunResult> {
  let resolved = await resolveDurableTarget(target);
	if (resolved.notFound) {
		return {
			confirmed: false,
			notFound: true,
			requested: false,
			state: "notFound",
			scope: null,
			steps: [],
		};
	}
	const reason = opts.reason?.trim() || "Stopped by user";
	const steps: StopDurableRunStep[] = [];

	// Cooperative interrupt: ask the agent to halt the current turn at a safe
	// boundary. Never force/purge/reap. For sessions this preserves the exact
	// `user.interrupt` wire shape the runtime already understands.
	if (opts.mode === "interrupt") {
		if (target.kind === "session") {
			const r = await raiseSessionEvent(target.id, "session.user_events", {
				events: [{ type: "user.interrupt" }],
			});
			steps.push({
				name: "interrupt:session",
				result: r.ok ? "ok" : "failed",
				detail: r.error,
			});
			// A 5xx (or transport) raise failure against a live session is transient
			// — distinct from "not running yet" (404/409). Surface it as retryable so
			// the route returns 503, not a misleading 409.
			const retryable = !r.ok && (r.status >= 500 || r.status === 0);
			return {
				confirmed: r.ok,
				notFound: false,
				requested: false,
				state: r.ok ? "confirmed" : "stopping",
				scope: resolved.scope,
				retryable,
				steps,
			};
		}
		for (const p of resolved.parentInstanceIds) {
			const r = await cascadeDeps.cancelParent?.(p, reason);
			steps.push({
				name: `interrupt:workflow:${p}`,
				result: r === "failed" ? "failed" : "ok",
				detail: r,
			});
		}
		const ok = steps.every((s) => s.result !== "failed");
		return {
			confirmed: ok,
			notFound: false,
			requested: false,
			state: ok ? "confirmed" : "stopping",
			scope: resolved.scope,
			steps,
		};
	}

	// Cooperative-first: when the caller doesn't specify a grace, give terminate/
	// purge/reset a short window so the cascade raises the cooperative cancel first
	// (the agent honors it at the next turn/tool boundary via the dapr-agent-py
	// cancel-key) and only force-terminates if it doesn't yield in time. Env-tunable;
	// 0 disables (pure force). Interrupt mode returns above and never reaches here.
  const defaultGraceMs = envSeconds(
    "LIFECYCLE_TERMINATE_GRACE_SECONDS",
    5,
    0,
    120,
  );
	const graceMs = Math.max(0, opts.graceMs ?? defaultGraceMs);
	// Persist the durable stop-intent up front so the row reads "Stopping…" and the
	// status confirmation path can finalize it after the in-request poll window
	// expires (e.g. a workflow blocked in a long activity). The whole
	// request/confirm contract, including cross-app wedge finalize, keys off
	// stop_requested_at, so a swallowed write here can leave a wedged run
	// permanently un-finalizable. Retry transient failures before giving up, and
	// surface a hard failure rather than silently proceeding.
  let persistedIntent: PersistedStopIntent | null = null;
	let stopIntentError: string | undefined;
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
      persistedIntent = await resolved.markStopRequested(
        reason,
        opts.mode as DurableStopMode,
      );
			break;
		} catch (err) {
			stopIntentError = err instanceof Error ? err.message : String(err);
			if (attempt < 3) await cascadeDeps.sleep(200 * attempt);
		}
	}
	steps.push({
		name: "mark-stop-requested",
    result: persistedIntent ? "ok" : "failed",
    detail: persistedIntent
      ? `mode=${persistedIntent.mode}`
      : `intent NOT persisted: ${stopIntentError}`,
	});
  if (!persistedIntent) {
    // Without durable intent the background reconciler has nothing authoritative
    // to retry. Fail closed before issuing any runtime or Kubernetes mutation.
    return {
      confirmed: false,
      notFound: false,
      requested: false,
      state: "stopping",
      scope: resolved.scope,
      retryable: true,
      steps,
    };
  }

  // Resolution before the stop write is only an authorization/identity snapshot.
  // Workflow child creation serializes on the same parent row and may have won
  // that lock immediately before markStopRequested. Re-resolve after the atomic
  // stop transaction so every child it stamped, plus its runtime/Sandbox linkage,
  // participates in this cascade and finalization decision.
  try {
    const refreshed = await resolveDurableTarget(target);
    if (refreshed.notFound)
      throw new Error("target disappeared after stop persistence");
    resolved = refreshed;
    steps.push({ name: "refresh-stop-targets", result: "ok" });
  } catch (err) {
    steps.push({
      name: "refresh-stop-targets",
      result: "failed",
      detail: err instanceof Error ? err.message : String(err),
    });
    return {
      confirmed: false,
      notFound: false,
      requested: true,
      state: "stopping",
      scope: resolved.scope,
      retryable: true,
      steps,
    };
  }

  // The database-returned mode is authoritative. It captures concurrent requests
  // and guarantees retries can escalate terminate -> purge -> reset but never
  // downgrade an already-persisted destructive intent.
  const effectiveMode = strongestStopMode(
    persistedIntent.mode,
    resolved.stopRequestedMode,
  );
  const purge = effectiveMode === "purge" || effectiveMode === "reset";
  const linkageBlocked = unresolvedLinkageBlocks(
    resolved,
    persistedIntent.requestedAt,
  );
  if (resolved.unresolvedRuntimeLinkages.length > 0) {
    steps.push({
      name: "resolve-runtime-linkage",
      result: linkageBlocked ? "partial" : "skipped",
      detail: linkageBlocked
        ? `waiting for ${resolved.unresolvedRuntimeLinkages.join(", ")}`
        : `provisioning grace elapsed for ${resolved.unresolvedRuntimeLinkages.join(", ")}`,
	});
  }
  const cascadePurge = purge && !linkageBlocked;
  let cascade: DurableCascadeResult;
  try {
    cascade = await runDurableCascade({
		parentInstanceIds: resolved.parentInstanceIds,
		agentRuntimeTargets: resolved.agentRuntimeTargets,
		statePurgeInstanceIds: resolved.statePurgeInstanceIds,
		reason,
      purge: cascadePurge,
		purgeGraceMs: 0,
      forceStatePurgeOnUnclosed: effectiveMode === "reset" && !linkageBlocked,
      allowMissingParentActorPurge:
        hasExactParentPurgeClosureEvidence(resolved),
		gracefulCancellationEnabled: graceMs > 0,
		gracefulCancellationWaitMs: graceMs,
		deps: cascadeDeps,
	});
  } catch (err) {
    steps.push({
      name: "durable-cascade",
      result: "failed",
      detail: err instanceof Error ? err.message : String(err),
    });
    return {
      confirmed: false,
      notFound: false,
      requested: true,
      state: "stopping",
      scope: resolved.scope,
      retryable: true,
      steps,
    };
  }
	steps.push({
		name: "durable-cascade",
		result: cascade.allClosed ? "ok" : "partial",
    detail: `parentClosed=${cascade.parentClosed} agentRuntimeClosed=${cascade.agentRuntimeClosed} purged=${cascadePurge}`,
	});

	// Not confirmed terminal in-request — e.g. a workflow blocked in a long
	// activity that only applies `terminate` once the activity yields (minutes
	// later). We still never flip DB rows / reap sandboxes until Dapr is confirmed
	// terminal (no lying about success), BUT the stop-intent is persisted and the
	// cascade keeps converging; a status poll finalizes once Dapr reports
	// terminal. Report "stopping" (HTTP 202), not a
	// hard 409 that leaves the row stale forever.
  if (!cascade.allClosed || linkageBlocked) {
		return {
			confirmed: false,
			notFound: false,
			requested: true,
			state: "stopping",
			scope: resolved.scope,
			cascade,
			steps,
		};
	}

  // Every terminal stop releases its dedicated compute host. `purge` controls
  // durable state deletion only; retaining state must not leave a running
  // Sandbox behind, and cleanup must not depend on whether closure happened in
  // this request or a later confirmation poll.
  let reapOk = true;
  for (const target of ownedRuntimeSandboxTargets(resolved)) {
    const name = target.runtimeSandboxName;
    try {
      if (!cascadeDeps.deleteRuntimeSandbox) {
        throw new Error("runtime Sandbox deletion is not configured");
      }
      await cascadeDeps.deleteRuntimeSandbox(target);
      steps.push({
        name: `reap-sandbox:${name}`,
        result: "ok",
        detail: "deleted-or-missing",
      });
    } catch (err) {
      reapOk = false;
      steps.push({
        name: `reap-sandbox:${name}`,
        result: "failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const workspaceCleanupOk = await (purge
    ? cleanupResolvedWorkspaces(resolved, true, (name, ok, detail) => {
        steps.push({
          name,
          result: ok ? "ok" : "failed",
          detail,
        });
      })
    : retainOrCleanupResolvedWorkspaces(resolved, new Date(), (name, ok, detail) => {
        steps.push({
          name,
          result: ok ? "ok" : "failed",
          detail,
        });
      }));
	const provisioningAckOk = reapOk
		? await acknowledgeResolvedProvisioningLeases(
				resolved,
				(name, ok, detail) => {
					steps.push({
						name,
						result: ok ? "ok" : "failed",
						detail,
					});
				},
			)
		: false;
  reapOk = reapOk && workspaceCleanupOk && provisioningAckOk;

  let dbOk = reapOk;
  if (!reapOk) {
    steps.push({
      name: "finalize-db",
      result: "skipped",
      detail: "Sandbox reap has not succeeded",
    });
  } else {
	try {
      const finalized = await resolved.finalizeDb(
        reason,
        opts.finalizeOutcome,
        effectiveMode,
      );
      if (finalized === "mode_changed") {
        dbOk = false;
        steps.push({
          name: "finalize-db",
          result: "partial",
          detail: "a stronger concurrent stop intent remains pending",
        });
      } else {
		steps.push({ name: "finalize-db", result: "ok" });
      }
	} catch (err) {
		dbOk = false;
		steps.push({
			name: "finalize-db",
			result: "failed",
			detail: err instanceof Error ? err.message : String(err),
		});
	}
  }

	const confirmed = reapOk && dbOk;
	return {
		confirmed,
		notFound: false,
		requested: true,
		// reap/finalize failures are transient bookkeeping — keep "stopping" so the
		// next status confirmation retries finalization rather than declaring
		// permanent success.
		state: confirmed ? "confirmed" : "stopping",
		scope: resolved.scope,
		cascade,
		steps,
	};
}

async function isInstanceClosed(
  getStatus: () => Promise<unknown>,
): Promise<boolean> {
	try {
		const s = await getStatus();
    return (
      s === DURABLE_RUNTIME_MISSING_STATUS || isTerminalDurableRuntimeStatus(s)
    );
	} catch {
		return false; // unknown -> not yet closed
	}
}

/** Reap the per-session Sandbox CRs and flip the owning DB rows terminal. */
async function purgeConfirmedState(
  resolved: Awaited<ReturnType<typeof resolveDurableTarget>>,
  allowMissingParentActorPurge: boolean,
): Promise<boolean> {
  try {
    await Promise.all(
      resolved.agentRuntimeTargets.map((target) =>
        cascadeDeps.purgeAgentRuntime(
          target.runtimeAppId,
          target.instanceId,
          target.runtimeSandboxName,
        ),
      ),
    );
    await Promise.all(
      resolved.parentInstanceIds.map(async (id) => {
        try {
          await cascadeDeps.purgeParent(id);
        } catch (err) {
          if (
            allowMissingParentActorPurge &&
            isBenignDaprPurgeMiss(err)
          ) {
            return;
          }
          throw err;
        }
      }),
    );
    await cascadeDeps.purgeStateRows?.(
      resolved.parentInstanceIds,
      resolved.agentRuntimeTargets,
      resolved.statePurgeInstanceIds,
    );
    return true;
  } catch (err) {
    console.warn(
      "confirmDurableStop: persisted durable-state purge failed:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

async function finalizeConfirmedStop(
	resolved: Awaited<ReturnType<typeof resolveDurableTarget>>,
	reason: string,
  expectedMode?: DurableStopMode,
  allowMissingParentActorPurge = false,
): Promise<{
  state: "confirmed" | "stopping";
  scope: DurableTargetScope | null;
}> {
  if (
    (expectedMode === "purge" || expectedMode === "reset") &&
    !(await purgeConfirmedState(resolved, allowMissingParentActorPurge))
  ) {
    return { state: "stopping", scope: resolved.scope };
  }
  let reapOk = true;
  for (const target of ownedRuntimeSandboxTargets(resolved)) {
    const name = target.runtimeSandboxName;
    try {
      if (!cascadeDeps.deleteRuntimeSandbox) {
        throw new Error("runtime Sandbox deletion is not configured");
      }
      await cascadeDeps.deleteRuntimeSandbox(target);
    } catch (err) {
      reapOk = false;
      console.warn(
        `confirmDurableStop: Sandbox ${name} reap failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  const destructive = expectedMode === "purge" || expectedMode === "reset";
  const reportWorkspaceResult = (name: string, ok: boolean, detail?: string) => {
    if (!ok) {
      console.warn(
        `confirmDurableStop: ${name} failed:`,
        detail ?? "unknown cleanup failure",
      );
    }
  };
  const workspaceCleanupOk = destructive
    ? await cleanupResolvedWorkspaces(resolved, true, reportWorkspaceResult)
    : await retainOrCleanupResolvedWorkspaces(
        resolved,
        new Date(),
        reportWorkspaceResult,
      );
	const provisioningAckOk = reapOk
		? await acknowledgeResolvedProvisioningLeases(
				resolved,
				(name, ok, detail) => {
					if (!ok) {
						console.warn(
							`confirmDurableStop: ${name} failed:`,
							detail ?? "unknown provisioning acknowledgement failure",
						);
					}
				},
			)
		: false;
  reapOk = reapOk && workspaceCleanupOk && provisioningAckOk;
  if (!reapOk) return { state: "stopping", scope: resolved.scope };
  try {
    const finalized = await resolved.finalizeDb(
      reason,
      undefined,
      expectedMode,
    );
    if (finalized === "mode_changed") {
      return { state: "stopping", scope: resolved.scope };
    }
  } catch (err) {
    console.warn(
      "confirmDurableStop: DB finalize failed:",
      err instanceof Error ? err.message : err,
    );
    return { state: "stopping", scope: resolved.scope };
	}
	return { state: "confirmed", scope: resolved.scope };
}

/**
 * Confirm convergence of a previously-requested stop (the "stopping" → "confirmed"
 * transition). Re-checks every durable handle (parent + per-session agent
 * runtimes); once all are terminal/gone it reaps the Sandbox CRs and flips the DB
 * terminal. It is idempotent, so repeated status polls can call it safely.
 * Returns "stopping" while any handle is still live (no DB flip, no lie).
 *
 * Cross-app child wedge: a `durable/run` parent awaits a per-session agent child
 * on a SEPARATE Dapr task hub, which a bare terminate/purge can never bring
 * terminal (Dapr's recursive terminate is task-hub-bounded). The cascade already
 * terminated that child, so once every agent-runtime child is terminal/gone, the
 * parent is just an idle zombie. After {@link WEDGE_FINALIZE_GRACE_MS} since the
 * stop was requested we force-delete the wedged parent's durable state rows
 * (the mode:"reset" mechanism) and finalize — rather than poll "stopping" forever.
 */
export async function confirmDurableStop(
	target: DurableRunTarget,
): Promise<{
  state: "confirmed" | "stopping" | "notFound";
  scope: DurableTargetScope | null;
}> {
	const resolved = await resolveDurableTarget(target);
	if (resolved.notFound) return { state: "notFound", scope: null };
  const linkageBlocked = unresolvedLinkageBlocks(
    resolved,
    resolved.stopRequestedAt,
  );
	const [parentClosedFlags, agentClosedFlags] = await Promise.all([
		Promise.all(
			resolved.parentInstanceIds.map((id) =>
				isInstanceClosed(() => cascadeDeps.getParentStatus(id)),
			),
		),
		Promise.all(
			resolved.agentRuntimeTargets.map((t) =>
        isInstanceClosed(() =>
          cascadeDeps.getAgentRuntimeStatus(
            t.runtimeAppId,
            t.instanceId,
            t.runtimeSandboxName,
          ),
        ),
			),
		),
	]);
	const parentClosed = parentClosedFlags.every(Boolean);
	const agentClosed = agentClosedFlags.every(Boolean);
  if (parentClosed && agentClosed && !linkageBlocked) {
    return finalizeConfirmedStop(
      resolved,
      "stop confirmed",
      resolved.stopRequestedAt
        ? normalizeDurableStopMode(resolved.stopRequestedMode)
        : undefined,
      hasExactParentPurgeClosureEvidence(resolved),
    );
	}

	// Cross-app child wedge: a still-RUNNING parent whose durable/run agent
	// child(ren) are all DB-terminal — terminated by the cascade OR crash-finalized
	// out-of-band by the liveness reconciler (session `failed`+completedAt) — but
	// which a bare terminate/purge can never bring terminal (the child
	// sub-orchestration lives on a separate Dapr task hub). We force-finalize on
	// POSITIVE evidence the whole agent side is dead: a stop was requested + the
	// grace elapsed + at least one durable/run child node is terminal + NO child is
	// still active ANYWHERE. That last guard is what keeps a healthy multi-branch
	// run safe (a parent legitimately awaiting a LATER live agent child is never
	// finalized). Crucially it does NOT require the parent's live currentNodeId to
	// still match the dead child's node: a parent that crashed an earlier
	// durable/run child and ADVANCED to a later approval-gate / non-agent node is
	// just as wedged, and the old currentNodeId-exact-match left it polling
	// "stopping" forever. `getParentCurrentNode` is fetched for the diagnostic log
	// only. See shouldForceFinalizeCrossAppWedge.
	let wedged = false;
	let wedgedParentNode: string | null = null;
	if (!parentClosed && resolved.terminatedChildNodes.length > 0) {
		wedged = shouldForceFinalizeCrossAppWedge({
			stopRequestedAt: resolved.stopRequestedAt,
			nowMs: Date.now(),
			graceMs: WEDGE_FINALIZE_GRACE_MS,
			parentCurrentNode: null,
			terminatedChildNodes: resolved.terminatedChildNodes,
			activeChildNodes: resolved.activeChildNodes,
		});
		if (wedged) {
			const firstRunning = resolved.parentInstanceIds.find(
				(_id, i) => !parentClosedFlags[i],
			);
			wedgedParentNode = firstRunning
				? ((await cascadeDeps.getParentCurrentNode?.(firstRunning)) ?? null)
				: null;
		}
	}
	if (wedged) {
		console.warn(
			`[wedge-eval] ${target.kind} ${target.id} FORCE-FINALIZE: cross-app child wedge — ` +
				`agent child terminal but parent(s) [${resolved.parentInstanceIds.join(", ")}] ` +
				`stuck RUNNING (live currentNode=${wedgedParentNode ?? "unknown"}, ` +
				`terminatedChildNodes=${resolved.terminatedChildNodes.length}); ` +
				`force-deleting parent durable state and finalizing`,
		);
		try {
			await cascadeDeps.purgeStateRows?.(
				resolved.parentInstanceIds,
				resolved.agentRuntimeTargets,
				resolved.statePurgeInstanceIds,
			);
		} catch (err) {
			console.warn(
				"confirmDurableStop: force state-row purge of wedged parent failed:",
				err instanceof Error ? err.message : err,
			);
      // The parent is still live until this direct state deletion succeeds.
      // Keep the persisted intent pending so reconciliation retries instead of
      // acknowledging a stop while durable work can still be replayed.
      return { state: "stopping", scope: resolved.scope };
		}
		const finalized = await finalizeConfirmedStop(
			resolved,
			"stop confirmed (cross-app wedge force-finalized)",
      resolved.stopRequestedAt
        ? normalizeDurableStopMode(resolved.stopRequestedMode)
        : undefined,
		);
		// Now that the state rows are gone the Dapr purge will 404 — best-effort.
		// Keep this after the DB finalize so a slow/unhealthy orchestrator purge
		// cannot leave an already-stopped child run stuck in "running".
		for (const id of resolved.parentInstanceIds) {
			try {
				await cascadeDeps.purgeParent(id);
			} catch {
				/* best-effort */
			}
		}
		return finalized;
	}

	// Still stopping — log WHY so a run in "stopping" limbo is diagnosable at a
	// glance (grep `[wedge-eval]`). Only for stop-requested runs; a confirm poll on
	// a run with no stop intent is not interesting. This is the counterpart to the
	// FORCE-FINALIZE line above: together they explain every wedge decision.
	if (resolved.stopRequestedAt != null) {
		const graceElapsedMs = Date.now() - resolved.stopRequestedAt.getTime();
		const reason = parentClosed
			? "parent durable tree closed; waiting on agent child to reach terminal"
			: resolved.terminatedChildNodes.length === 0
				? "no terminal durable/run child — parent still doing real work, not a dead-agent wedge"
				: resolved.activeChildNodes.length > 0
					? `a durable/run child is still active ([${resolved.activeChildNodes.join(", ")}]) — not finalizing over live work`
					: graceElapsedMs < WEDGE_FINALIZE_GRACE_MS
						? `wedge condition met; holding for grace (${Math.round(graceElapsedMs / 1000)}s/${Math.round(WEDGE_FINALIZE_GRACE_MS / 1000)}s)`
						: "wedge condition met + grace elapsed but not force-finalized (unexpected — investigate)";
		console.info(
			`[wedge-eval] ${target.kind} ${target.id} still stopping: ` +
				`parentClosed=${parentClosed} agentClosed=${agentClosed} ` +
				`terminatedChildNodes=${resolved.terminatedChildNodes.length} ` +
				`activeChildNodes=${resolved.activeChildNodes.length} ` +
				`graceElapsed=${Math.round(graceElapsedMs / 1000)}s → ${reason}`,
		);
	}

	return { state: "stopping", scope: resolved.scope };
}

/**
 * Converge a session the liveness reconciler has determined is CRASHED (its Dapr
 * instance is gone AND its Sandbox CR + pod are absent). This is a thin alias for
 * the ONE purge path — `stopDurableRun` in `reset` mode (purge + force-delete the
 * scoped state rows, since the worker is provably gone so a terminate can't apply,
 * no cooperative wait) — with the `crashed` finalize outcome so the row lands
 * `failed` + stopReason `{type:"crashed"}` + completedAt instead of `terminated`.
 * No bespoke DB flip: Dapr and DB converge together.
 */
export function convergeCrashedSession(
	target: DurableRunTarget,
	opts: { reason?: string } = {},
): Promise<StopDurableRunResult> {
	return stopDurableRun(target, {
		mode: "reset",
    reason:
      opts.reason?.trim() || "Converged crashed session (liveness reconciler)",
		finalizeOutcome: "crashed",
		graceMs: 0,
	});
}

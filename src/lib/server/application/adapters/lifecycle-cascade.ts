import { sql } from "drizzle-orm";
import { db as defaultDb } from "$lib/server/db";
import {
	daprFetch,
	getDaprSidecarUrl,
	getOrchestratorUrl,
} from "$lib/server/dapr-client";
import {
  deleteSessionRuntimeExitedPods,
  getAgentWorkflowHostPod,
  getKubernetesSandbox,
  getSessionRuntimePodPresence,
  getSessionRuntimePodStatus,
  resumeSessionSandbox,
  sandboxDesiredRunning,
} from "$lib/server/kube/client";
import { waitForAgentWorkflowHostAppReady } from "$lib/server/sessions/agent-workflow-host";
import { openshellRuntimeFetch } from "$lib/server/openshell-runtime";
import { cleanupSessionSandboxStrict } from "$lib/server/sandboxes/provision";
import type {
  SessionRuntimeCleanupPort,
  SessionRuntimeInspectionPort,
  SessionRuntimeInstanceState,
  SessionSandboxDestroyer,
} from "$lib/server/application/ports";
import { SandboxExecutionApiSessionSandboxDestroyer } from "$lib/server/application/adapters/session-sandbox-destroyer";
import {
	type AgentRuntimeTarget,
	type DurableCascadeDeps,
	type DurableGracefulCancellationResult,
	type DurableTerminationResult,
	DURABLE_RUNTIME_MISSING_STATUS,
	daprStateKeyMatchPattern,
	durableRuntimeStatusFromBody,
	isBenignDaprTerminationMiss,
	isRecoverableDaprWorkflowTerminateError,
	isTerminalDurableRuntimeStatus,
	isTransientDaprServiceInvokeError,
	sleep,
	waitForDurableRuntimeClosedWithin,
} from "$lib/server/lifecycle/cascade";

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_WAIT_MS = 90_000;
const DEFAULT_WAIT_POLL_MS = 1_000;
const WORKFLOW_STATE_ROW_TABLE = "wfstate_state";
const LEGACY_WORKFLOW_STATE_ROW_TABLE = "state";
const AGENT_STATE_ROW_TABLE = "agent_py_state";

type Database = typeof defaultDb;

function postgresErrorCode(error: unknown): string | null {
	const visited = new Set<object>();
	let current: unknown = error;
	while (current && typeof current === "object" && !visited.has(current)) {
		visited.add(current);
		const code = Reflect.get(current, "code");
		if (typeof code === "string") return code;
		current = Reflect.get(current, "cause");
	}
	return null;
}

function isUndefinedTableError(error: unknown): boolean {
	return postgresErrorCode(error) === "42P01";
}

export type CreateDaprCascadeDepsOptions = {
	requestTimeoutMs?: number;
	waitMs?: number;
	waitPollMs?: number;
  /** Resolve a per-session Sandbox host without collapsing uncertainty to absence. */
  locateAgentWorkflowHost?: (
    runtimeAppId: string,
    runtimeSandboxName: string,
  ) => Promise<AgentWorkflowHostLocation>;
  /** Wake a known Sandbox host before a lifecycle control operation. */
  activateAgentWorkflowHost?: (
    runtimeAppId: string,
    runtimeSandboxName: string,
  ) => Promise<AgentWorkflowHostLocation>;
  /** Provider-owned session Sandbox teardown. */
  sandboxDestroyer?: Pick<SessionSandboxDestroyer, "deleteRuntimeSandbox">;
};

export type AgentWorkflowHostLocation =
  | { state: "ready"; baseUrl: string }
  | { state: "present" }
  | { state: "absent" }
  | { state: "unknown" };

type AgentRuntimeEndpoint =
  | { kind: "dapr"; baseUrl: string }
  | { kind: "direct"; baseUrl: string }
  | { kind: "absent" }
  | { kind: "unknown" };

async function defaultAgentWorkflowHostLocation(
  runtimeAppId: string,
  runtimeSandboxName: string,
): Promise<AgentWorkflowHostLocation> {
  try {
    const pod = await getAgentWorkflowHostPod(runtimeAppId);
    if (pod?.podIP) {
      return { state: "ready", baseUrl: `http://${pod.podIP}:8002` };
    }
  } catch {
    // Continue to the independent CR/pod presence checks below.
  }

  // A scaled-to-zero Sandbox intentionally has no pod while its durable workflow
  // remains parked in the task hub. The named CR is therefore positive evidence
  // that the runtime is present, not evidence that it has terminated.
  try {
    const sandbox = await getKubernetesSandbox(runtimeSandboxName);
    if (sandbox) return { state: "present" };
  } catch {
    return { state: "unknown" };
  }
  const presence = await getSessionRuntimePodPresence({ runtimeAppId });
  return presence === "absent" ? { state: "absent" } : { state: "unknown" };
}

async function defaultAgentWorkflowHostActivation(
  runtimeAppId: string,
  runtimeSandboxName: string,
): Promise<AgentWorkflowHostLocation> {
  const initial = await defaultAgentWorkflowHostLocation(
    runtimeAppId,
    runtimeSandboxName,
  );
  if (initial.state === "absent" || initial.state === "unknown") return initial;

  try {
    // Pod discovery proves an address exists, not that the runtime has finished
    // startup. Every mutating control waits for the application contract; read-only
    // status resolution deliberately does not enter this activation path.
    if (initial.state === "ready") {
      const ready = await waitForAgentWorkflowHostAppReady({
        agentAppId: runtimeAppId,
      });
      return { state: "ready", baseUrl: ready.baseUrl };
    }

    const sandbox = await getKubernetesSandbox(runtimeSandboxName);
    if (!sandbox) {
      return defaultAgentWorkflowHostLocation(runtimeAppId, runtimeSandboxName);
    }
    if (sandbox.metadata?.deletionTimestamp) return { state: "present" };

    const pod = await getSessionRuntimePodStatus({ runtimeAppId });
    if (pod.presence === "unknown") return { state: "unknown" };
    if (pod.exited) {
      await deleteSessionRuntimeExitedPods({ runtimeAppId });
    }
    if (!sandboxDesiredRunning(sandbox)) {
      const resumed = await resumeSessionSandbox(runtimeSandboxName);
      if (resumed === "missing") {
        return defaultAgentWorkflowHostLocation(
          runtimeAppId,
          runtimeSandboxName,
        );
      }
    }

    const ready = await waitForAgentWorkflowHostAppReady({
      agentAppId: runtimeAppId,
    });
    return { state: "ready", baseUrl: ready.baseUrl };
  } catch {
    // A failed wake/readiness probe is uncertainty, never proof of termination.
    const afterFailure = await defaultAgentWorkflowHostLocation(
      runtimeAppId,
      runtimeSandboxName,
    );
    return afterFailure.state === "absent"
      ? afterFailure
      : { state: "unknown" };
  }
}

function responseDetail(raw: string): string {
  try {
    const body = JSON.parse(raw) as { detail?: unknown };
    if (typeof body.detail === "string") return body.detail.trim();
  } catch {
    // Some runtimes return a plain-text detail.
  }
  return raw.trim();
}

function isCanonicalAgentRunNotFound(raw: string): boolean {
  return responseDetail(raw).toLowerCase() === "agent run not found";
}

class AgentRuntimeStatusHttpError extends Error {}

/**
 * Build a {@link DurableCascadeDeps} that talks to the orchestrator over Dapr,
 * shared agent runtimes through Dapr service invocation, and explicitly linked
 * per-session Sandbox runtimes through their app endpoint.
 * Postgres is used only as an infrastructure adapter for scoped Dapr state-row
 * purge when reset/wedge finalization needs byte-clean durable state.
 */
export function createDaprCascadeDeps(
	opts: CreateDaprCascadeDepsOptions = {},
	database: Database = defaultDb,
): DurableCascadeDeps {
	const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
	const waitPollMs = opts.waitPollMs ?? DEFAULT_WAIT_POLL_MS;
  const locateAgentWorkflowHost =
    opts.locateAgentWorkflowHost ?? defaultAgentWorkflowHostLocation;
  const activateAgentWorkflowHost =
    opts.activateAgentWorkflowHost ??
    (opts.locateAgentWorkflowHost
      ? opts.locateAgentWorkflowHost
      : defaultAgentWorkflowHostActivation);
  const sandboxDestroyer =
    opts.sandboxDestroyer ?? new SandboxExecutionApiSessionSandboxDestroyer();

  async function safelyLocateAgentWorkflowHost(
    runtimeAppId: string,
    runtimeSandboxName: string,
  ): Promise<AgentWorkflowHostLocation> {
    try {
      return await locateAgentWorkflowHost(runtimeAppId, runtimeSandboxName);
    } catch {
      return { state: "unknown" };
    }
  }

  async function resolveAgentRuntimeEndpoint(
    runtimeAppId: string,
    runtimeSandboxName?: string | null,
    activate = false,
  ): Promise<AgentRuntimeEndpoint> {
    const sandboxName = runtimeSandboxName?.trim();
    if (!sandboxName) {
      return { kind: "dapr", baseUrl: getDaprSidecarUrl() };
    }
    let location: AgentWorkflowHostLocation;
    try {
      location = await (activate
        ? activateAgentWorkflowHost(runtimeAppId, sandboxName)
        : safelyLocateAgentWorkflowHost(runtimeAppId, sandboxName));
    } catch {
      location = { state: "unknown" };
    }
    if (location.state === "ready") {
      return {
        kind: "direct",
        baseUrl: location.baseUrl.replace(/\/+$/, ""),
      };
    }
    return { kind: location.state === "present" ? "unknown" : location.state };
  }

  async function directAgentRuntimeLocationAfterFailure(
    runtimeAppId: string,
    runtimeSandboxName: string | null | undefined,
    endpoint: AgentRuntimeEndpoint,
  ): Promise<AgentWorkflowHostLocation> {
    if (endpoint.kind !== "direct" || !runtimeSandboxName?.trim()) {
      return { state: "unknown" };
    }
    return safelyLocateAgentWorkflowHost(
      runtimeAppId,
      runtimeSandboxName.trim(),
    );
  }

  function agentRuntimeUrl(
    endpoint: Extract<AgentRuntimeEndpoint, { kind: "dapr" | "direct" }>,
    runtimeAppId: string,
    path: string,
  ): string {
    if (endpoint.kind === "direct") return `${endpoint.baseUrl}${path}`;
    return `${endpoint.baseUrl}/v1.0/invoke/${encodeURIComponent(runtimeAppId)}/method${path}`;
  }

	async function getParentStatus(instanceId: string): Promise<unknown> {
		try {
			const res = await daprFetch(
				`${getOrchestratorUrl()}/api/v2/workflows/${encodeURIComponent(instanceId)}/status`,
				{ method: "GET", signal: AbortSignal.timeout(5_000), maxRetries: 0 },
			);
			if (res.status === 404) return DURABLE_RUNTIME_MISSING_STATUS;
			if (!res.ok) {
				const detail = await res.text().catch(() => "");
				if (isBenignDaprTerminationMiss(detail))
					return DURABLE_RUNTIME_MISSING_STATUS;
				if (isTransientDaprServiceInvokeError(detail)) return null;
				throw new Error(
					`status request failed with ${res.status}${detail ? `: ${detail}` : ""}`,
				);
			}
			return durableRuntimeStatusFromBody(await res.json().catch(() => null));
		} catch (err) {
			if (isBenignDaprTerminationMiss(err))
				return DURABLE_RUNTIME_MISSING_STATUS;
			if (isTransientDaprServiceInvokeError(err)) return null;
			throw err;
		}
	}

	async function getParentCurrentNode(
		instanceId: string,
	): Promise<string | null> {
		try {
			const res = await daprFetch(
				`${getOrchestratorUrl()}/api/v2/workflows/${encodeURIComponent(instanceId)}/status`,
				{ method: "GET", signal: AbortSignal.timeout(5_000), maxRetries: 0 },
			);
			if (!res.ok) return null;
			const body = (await res.json().catch(() => null)) as Record<
				string,
				unknown
			> | null;
			const node = body?.currentNodeId;
			return typeof node === "string" && node.trim() ? node.trim() : null;
		} catch {
			return null;
		}
	}

	async function getAgentRuntimeStatus(
		runtimeAppId: string,
		instanceId: string,
    runtimeSandboxName?: string | null,
	): Promise<unknown> {
    const endpoint = await resolveAgentRuntimeEndpoint(
      runtimeAppId,
      runtimeSandboxName,
    );
    if (endpoint.kind === "absent") return DURABLE_RUNTIME_MISSING_STATUS;
    if (endpoint.kind === "unknown") return null;
		try {
			const res = await daprFetch(
        agentRuntimeUrl(
          endpoint,
          runtimeAppId,
          `/api/v2/agent-runs/${encodeURIComponent(instanceId)}/status?summary=true`,
        ),
				{ method: "GET", signal: AbortSignal.timeout(10_000), maxRetries: 0 },
			);
      if (res.status === 404) {
        const detail = await res.text().catch(() => "");
        if (isCanonicalAgentRunNotFound(detail)) {
          return DURABLE_RUNTIME_MISSING_STATUS;
        }
        if (endpoint.kind !== "direct") return null;

        // Old Pydantic runtime images predate the shared status contract. Their
        // legacy endpoint is a temporary compatibility bridge while those pods drain.
        const legacy = await daprFetch(
          `${endpoint.baseUrl}/agent/instances/${encodeURIComponent(instanceId)}`,
          { method: "GET", signal: AbortSignal.timeout(10_000), maxRetries: 0 },
        );
        if (legacy.ok) {
          return durableRuntimeStatusFromBody(
            await legacy.json().catch(() => null),
          );
        }
        const legacyDetail = await legacy.text().catch(() => "");
        if (
          legacy.status === 404 &&
          isCanonicalAgentRunNotFound(legacyDetail)
        ) {
          return DURABLE_RUNTIME_MISSING_STATUS;
        }
        if (legacy.status === 404) return null;
        throw new AgentRuntimeStatusHttpError(
          `legacy status request failed with ${legacy.status}${legacyDetail ? `: ${legacyDetail}` : ""}`,
        );
      }
			if (!res.ok) {
				const detail = await res.text().catch(() => "");
        if (endpoint.kind === "dapr" && isBenignDaprTerminationMiss(detail)) {
					return DURABLE_RUNTIME_MISSING_STATUS;
        }
        if (
          endpoint.kind === "dapr" &&
          isTransientDaprServiceInvokeError(detail)
        ) {
          return null;
        }
        throw new AgentRuntimeStatusHttpError(
					`status request failed with ${res.status}${detail ? `: ${detail}` : ""}`,
				);
			}
			return durableRuntimeStatusFromBody(await res.json().catch(() => null));
		} catch (err) {
      if (endpoint.kind === "direct") {
        if (err instanceof AgentRuntimeStatusHttpError) throw err;
        const location = await directAgentRuntimeLocationAfterFailure(
          runtimeAppId,
          runtimeSandboxName,
          endpoint,
        );
        if (location.state === "absent") {
          return DURABLE_RUNTIME_MISSING_STATUS;
        }
        if (location.state === "unknown") return null;
        throw err;
      }
			if (isBenignDaprTerminationMiss(err))
				return DURABLE_RUNTIME_MISSING_STATUS;
			if (isTransientDaprServiceInvokeError(err)) return null;
			throw err;
		}
	}

	async function cancelParent(
		instanceId: string,
		reason: string,
	): Promise<DurableGracefulCancellationResult> {
		try {
			const res = await daprFetch(
				`${getOrchestratorUrl()}/api/v2/workflows/${encodeURIComponent(instanceId)}/events`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						eventName: "workflow.cancel",
						eventData: {
							reason,
							source: "lifecycle_controller",
							cancelledAt: new Date().toISOString(),
						},
					}),
					maxRetries: 0,
					signal: AbortSignal.timeout(requestTimeoutMs),
				},
			);
			if (!res.ok) {
				const detail = await res.text().catch(() => "");
				if (res.status === 404 || isBenignDaprTerminationMiss(detail))
					return "alreadyGone";
				return "failed";
			}
			return "requested";
		} catch (err) {
			if (isBenignDaprTerminationMiss(err)) return "alreadyGone";
			return "failed";
		}
	}

	async function cancelAgentRuntime(
		runtimeAppId: string,
		instanceId: string,
		reason: string,
    runtimeSandboxName?: string | null,
	): Promise<DurableGracefulCancellationResult> {
    const endpoint = await resolveAgentRuntimeEndpoint(
      runtimeAppId,
      runtimeSandboxName,
      true,
    );
    if (endpoint.kind === "absent") return "alreadyGone";
    if (endpoint.kind === "unknown") return "failed";
		try {
			const res = await daprFetch(
        agentRuntimeUrl(
          endpoint,
          runtimeAppId,
          "/internal/sessions/raise-event",
        ),
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						instanceId,
						eventName: "session.terminate",
						payload: {
							reason,
							source: "lifecycle_controller",
							cancelledAt: new Date().toISOString(),
						},
					}),
					maxRetries: 0,
					signal: AbortSignal.timeout(requestTimeoutMs),
				},
			);
			if (!res.ok) {
				const detail = await res.text().catch(() => "");
        if (
          endpoint.kind === "dapr" &&
          (res.status === 404 || isBenignDaprTerminationMiss(detail))
        ) {
					return "alreadyGone";
        }
				return "failed";
			}
			return "requested";
		} catch (err) {
      if (endpoint.kind === "direct") {
        const location = await directAgentRuntimeLocationAfterFailure(
          runtimeAppId,
          runtimeSandboxName,
          endpoint,
        );
        return location.state === "absent" ? "alreadyGone" : "failed";
      }
			if (isBenignDaprTerminationMiss(err)) return "alreadyGone";
			return "failed";
		}
	}

	async function terminateParent(
		instanceId: string,
		reason: string,
	): Promise<DurableTerminationResult> {
		try {
			const res = await daprFetch(
				`${getOrchestratorUrl()}/api/v2/workflows/${encodeURIComponent(instanceId)}/terminate`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ reason }),
					maxRetries: 0,
					signal: AbortSignal.timeout(requestTimeoutMs),
				},
			);
			if (!res.ok) {
				const detail = await res.text().catch(() => "");
				if (res.status === 404 || isBenignDaprTerminationMiss(detail))
					return "alreadyGone";
				if (
					res.status >= 500 &&
					(isRecoverableDaprWorkflowTerminateError(detail) ||
						isTransientDaprServiceInvokeError(detail))
				) {
					return "terminated";
				}
				return "failed";
			}
			return "terminated";
		} catch (err) {
			if (isBenignDaprTerminationMiss(err)) return "alreadyGone";
			if (
				isRecoverableDaprWorkflowTerminateError(err) ||
				isTransientDaprServiceInvokeError(err)
			) {
				return "terminated";
			}
			return "failed";
		}
	}

	async function terminateAgentRuntime(
		runtimeAppId: string,
		instanceId: string,
		reason: string,
    runtimeSandboxName?: string | null,
	): Promise<DurableTerminationResult> {
    const endpoint = await resolveAgentRuntimeEndpoint(
      runtimeAppId,
      runtimeSandboxName,
      true,
    );
    if (endpoint.kind === "absent") return "alreadyGone";
    if (endpoint.kind === "unknown") return "failed";
		try {
			const res = await daprFetch(
        agentRuntimeUrl(
          endpoint,
          runtimeAppId,
          `/api/v2/agent-runs/${encodeURIComponent(instanceId)}/terminate`,
        ),
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ reason }),
					maxRetries: 0,
					signal: AbortSignal.timeout(requestTimeoutMs),
				},
			);
			if (!res.ok) {
				const detail = await res.text().catch(() => "");
        if (
          endpoint.kind === "dapr" &&
          (res.status === 404 || isBenignDaprTerminationMiss(detail))
        ) {
					return "alreadyGone";
        }
				if (
          endpoint.kind === "dapr" &&
					res.status >= 500 &&
					(isRecoverableDaprWorkflowTerminateError(detail) ||
						isTransientDaprServiceInvokeError(detail))
				) {
					return "terminated";
				}
				return "failed";
			}
			return "terminated";
		} catch (err) {
      if (endpoint.kind === "direct") {
        const location = await directAgentRuntimeLocationAfterFailure(
          runtimeAppId,
          runtimeSandboxName,
          endpoint,
        );
        return location.state === "absent" ? "alreadyGone" : "failed";
      }
			if (isBenignDaprTerminationMiss(err)) return "alreadyGone";
			if (
				isRecoverableDaprWorkflowTerminateError(err) ||
				isTransientDaprServiceInvokeError(err)
			) {
				return "terminated";
			}
			return "failed";
		}
	}

	async function purgeParent(instanceId: string): Promise<void> {
		try {
			const res = await daprFetch(
				`${getOrchestratorUrl()}/api/v2/workflows/${encodeURIComponent(instanceId)}?recursive=true`,
				{
					method: "DELETE",
					signal: AbortSignal.timeout(requestTimeoutMs),
					maxRetries: 0,
				},
			);
			if (!res.ok) {
				const detail = await res.text().catch(() => "");
				if (res.status === 404 || isBenignDaprTerminationMiss(detail)) return;
        throw new Error(
          `workflow purge failed with ${res.status}${detail ? `: ${detail}` : ""}`,
				);
			}
		} catch (err) {
			if (isBenignDaprTerminationMiss(err)) return;
      throw new Error(
        `Failed to purge workflow ${instanceId}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	async function purgeAgentRuntime(
		runtimeAppId: string,
		instanceId: string,
    runtimeSandboxName?: string | null,
	): Promise<void> {
    const endpoint = await resolveAgentRuntimeEndpoint(
      runtimeAppId,
      runtimeSandboxName,
      true,
    );
    if (endpoint.kind === "absent") return;
    if (endpoint.kind === "unknown") {
      throw new Error(
        `Cannot purge agent runtime ${runtimeAppId}/${instanceId}: Sandbox host location is unknown`,
      );
    }
		try {
			const res = await daprFetch(
        agentRuntimeUrl(
          endpoint,
          runtimeAppId,
          `/api/v2/agent-runs/${encodeURIComponent(instanceId)}?recursive=true`,
        ),
				{
					method: "DELETE",
					signal: AbortSignal.timeout(requestTimeoutMs),
					maxRetries: 0,
				},
			);
			if (!res.ok) {
				const detail = await res.text().catch(() => "");
        if (
          (endpoint.kind === "dapr" &&
            (res.status === 404 || isBenignDaprTerminationMiss(detail))) ||
          (endpoint.kind === "direct" &&
            res.status === 404 &&
            isCanonicalAgentRunNotFound(detail))
        ) {
          return;
        }
        throw new Error(
          `agent runtime purge failed with ${res.status}${detail ? `: ${detail}` : ""}`,
				);
			}
		} catch (err) {
      if (endpoint.kind === "direct") {
        const location = await directAgentRuntimeLocationAfterFailure(
          runtimeAppId,
          runtimeSandboxName,
          endpoint,
        );
        if (location.state === "absent") return;
      } else if (isBenignDaprTerminationMiss(err)) {
        return;
      }
      throw new Error(
        `Failed to purge agent runtime ${runtimeAppId}/${instanceId}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	async function purgeStateRows(
		parentInstanceIds: string[],
		agentRuntimeTargets: AgentRuntimeTarget[],
		statePurgeInstanceIds: string[] = [],
	): Promise<void> {
		const ids = new Set<string>();
		for (const id of [...parentInstanceIds, ...statePurgeInstanceIds]) {
			const normalized = id.trim();
			if (normalized) ids.add(normalized);
		}
		for (const target of agentRuntimeTargets) {
			const normalized = target.instanceId.trim();
			if (normalized) ids.add(normalized);
		}
		if (ids.size === 0 || !database) return;
		const instanceIds = [...ids];

		async function deleteRows(
			table: string,
			instanceId: string,
		): Promise<void> {
			const pattern = daprStateKeyMatchPattern(instanceId);
			try {
				await database.execute(sql`
					delete from ${sql.raw(table)}
					where lower(key) ~ ${pattern}
				`);
			} catch (err) {
				throw new Error(
					`Failed to delete Dapr state rows from ${table} for ${instanceId}: ${err instanceof Error ? err.message : String(err)}`,
					{ cause: err },
				);
			}
		}

		// state.postgresql/v2 honors tablePrefix (`wfstate_state`). Older preview
		// environments used v1, which ignored that prefix and created `state`.
		// Fall back only when PostgreSQL proves the v2 table is absent; all other
		// failures remain fail-closed so lifecycle confirmation keeps retrying.
		let workflowTable = WORKFLOW_STATE_ROW_TABLE;
		for (const instanceId of instanceIds) {
			try {
				await deleteRows(workflowTable, instanceId);
			} catch (err) {
				if (
					workflowTable !== WORKFLOW_STATE_ROW_TABLE ||
					!isUndefinedTableError(err)
				) {
					throw err;
				}
				workflowTable = LEGACY_WORKFLOW_STATE_ROW_TABLE;
				await deleteRows(workflowTable, instanceId);
			}
		}

		// Boundary-anchored match: the instanceId must be a whole token in the
		// Dapr key — preceded by `||` (workflow state) or `_workflow_` (agent
		// application state) and followed by `||`, `__turn__` (turn sub-instance),
		// or end-of-key. A bare substring match would let `..._run__1` also delete
		// sibling state for `..._run__10`/`..._run__11`.
		for (const instanceId of instanceIds) {
			await deleteRows(AGENT_STATE_ROW_TABLE, instanceId);
		}
	}

  async function deleteWorkspaceSandbox(sandboxName: string): Promise<void> {
    const normalized = sandboxName.trim();
    if (!normalized)
      throw new Error("workspace Sandbox deletion requires a name");
    const response = await openshellRuntimeFetch(
      `/api/v1/sandboxes/${encodeURIComponent(normalized)}`,
      { method: "DELETE" },
    );
    if (response.ok) return;
    const detail = (await response.text().catch(() => "")).slice(0, 500);
    if (
      response.status === 404 ||
      detail.toLowerCase().includes("sandbox not found")
    ) {
      return;
    }
    throw new Error(
      `OpenShell Sandbox ${normalized} deletion failed (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }

  async function deleteRuntimeSandbox(target: {
    runtimeAppId: string;
    runtimeSandboxName: string;
  }): Promise<void> {
    const expectedSandboxName = `agent-host-${target.runtimeAppId}`;
    if (target.runtimeSandboxName !== expectedSandboxName) {
      throw new Error(
        `runtime target mismatch: ${target.runtimeAppId} does not own ${target.runtimeSandboxName}`,
      );
    }
    const result = await sandboxDestroyer.deleteRuntimeSandbox(
      target.runtimeSandboxName,
    );
    if (result.status === "error") {
      throw new Error(
        result.error || `runtime Sandbox ${target.runtimeSandboxName} deletion failed`,
      );
    }
  }

	const waitParentClosed = (instanceId: string) =>
		waitForDurableRuntimeClosedWithin(
			`workflow ${instanceId}`,
			() => getParentStatus(instanceId),
			waitMs,
			sleep,
			waitPollMs,
		);
  const waitAgentRuntimeClosed = (
    runtimeAppId: string,
    instanceId: string,
    runtimeSandboxName?: string | null,
  ) =>
		waitForDurableRuntimeClosedWithin(
			`agent runtime ${runtimeAppId}/${instanceId}`,
      () => getAgentRuntimeStatus(runtimeAppId, instanceId, runtimeSandboxName),
			waitMs,
			sleep,
			waitPollMs,
		);

	return {
		getParentStatus,
		getParentCurrentNode,
		cancelParent,
		terminateParent,
		waitParentClosed,
		getAgentRuntimeStatus,
		cancelAgentRuntime,
		terminateAgentRuntime,
		waitAgentRuntimeClosed,
		purgeParent,
		purgeAgentRuntime,
		purgeStateRows,
    deleteRuntimeSandbox,
    deleteWorkspaceSandbox,
    cleanupWorkspaceExecution: cleanupSessionSandboxStrict,
		sleep,
	};
}

export class DaprSessionRuntimeCleanupAdapter implements SessionRuntimeCleanupPort {
  constructor(
    private readonly lifecycle: Pick<
      DurableCascadeDeps,
      "purgeAgentRuntime"
    > = createDaprCascadeDeps(),
  ) {}

  async purgeRuntimeInstance(input: {
    runtimeAppId: string;
    instanceId: string;
    runtimeSandboxName: string | null;
  }): Promise<void> {
    await this.lifecycle.purgeAgentRuntime(
      input.runtimeAppId,
      input.instanceId,
      input.runtimeSandboxName,
    );
  }
}

export class DaprSessionRuntimeInspectionAdapter
  implements SessionRuntimeInspectionPort
{
  constructor(
    private readonly lifecycle: Pick<
      DurableCascadeDeps,
      "getAgentRuntimeStatus"
    > = createDaprCascadeDeps(),
  ) {}

  async inspectRuntimeInstance(input: {
    runtimeAppId: string;
    instanceId: string;
    runtimeSandboxName: string | null;
  }): Promise<SessionRuntimeInstanceState> {
    try {
      const status = await this.lifecycle.getAgentRuntimeStatus(
        input.runtimeAppId,
        input.instanceId,
        input.runtimeSandboxName,
      );
      if (status === DURABLE_RUNTIME_MISSING_STATUS) return "not_found";
      if (status == null) return "unknown";
      return isTerminalDurableRuntimeStatus(status) ? "terminal" : "active";
    } catch {
      return "unknown";
    }
  }
}

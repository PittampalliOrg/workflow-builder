import { sql } from "drizzle-orm";
import { db as defaultDb } from "$lib/server/db";
import {
	daprFetch,
	getDaprSidecarUrl,
	getOrchestratorUrl,
} from "$lib/server/dapr-client";
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
	isTransientDaprServiceInvokeError,
	sleep,
	waitForDurableRuntimeClosedWithin,
} from "$lib/server/lifecycle/cascade";

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_WAIT_MS = 90_000;
const DEFAULT_WAIT_POLL_MS = 1_000;
const DAPR_STATE_ROW_TABLES = ["wfstate_state", "agent_py_state"] as const;

type Database = typeof defaultDb;

export type CreateDaprCascadeDepsOptions = {
	requestTimeoutMs?: number;
	waitMs?: number;
	waitPollMs?: number;
};

/**
 * Build a {@link DurableCascadeDeps} that talks to the orchestrator + per-session
 * agent runtimes over Dapr (the same wire calls the benchmark cascade makes).
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
	): Promise<unknown> {
		try {
			const res = await daprFetch(
				`${getDaprSidecarUrl()}/v1.0/invoke/${encodeURIComponent(runtimeAppId)}/method/api/v2/agent-runs/${encodeURIComponent(instanceId)}/status?summary=true`,
				{ method: "GET", signal: AbortSignal.timeout(10_000), maxRetries: 0 },
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
	): Promise<DurableGracefulCancellationResult> {
		try {
			const res = await daprFetch(
				`${getDaprSidecarUrl()}/v1.0/invoke/${encodeURIComponent(runtimeAppId)}/method/internal/sessions/raise-event`,
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
	): Promise<DurableTerminationResult> {
		try {
			const res = await daprFetch(
				`${getDaprSidecarUrl()}/v1.0/invoke/${encodeURIComponent(runtimeAppId)}/method/api/v2/agent-runs/${encodeURIComponent(instanceId)}/terminate`,
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
				console.warn(
					`Failed to purge workflow ${instanceId}: ${res.status} ${detail}`,
				);
			}
		} catch (err) {
			if (isBenignDaprTerminationMiss(err)) return;
			console.warn(
				`Failed to purge workflow ${instanceId}:`,
				err instanceof Error ? err.message : err,
			);
		}
	}

	async function purgeAgentRuntime(
		runtimeAppId: string,
		instanceId: string,
	): Promise<void> {
		try {
			const res = await daprFetch(
				`${getDaprSidecarUrl()}/v1.0/invoke/${encodeURIComponent(runtimeAppId)}/method/api/v2/agent-runs/${encodeURIComponent(instanceId)}?recursive=true`,
				{
					method: "DELETE",
					signal: AbortSignal.timeout(requestTimeoutMs),
					maxRetries: 0,
				},
			);
			if (!res.ok) {
				const detail = await res.text().catch(() => "");
				if (res.status === 404 || isBenignDaprTerminationMiss(detail)) return;
				console.warn(
					`Failed to purge agent runtime ${runtimeAppId}/${instanceId}: ${res.status} ${detail}`,
				);
			}
		} catch (err) {
			if (isBenignDaprTerminationMiss(err)) return;
			console.warn(
				`Failed to purge agent runtime ${runtimeAppId}/${instanceId}:`,
				err instanceof Error ? err.message : err,
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
		for (const table of DAPR_STATE_ROW_TABLES) {
			for (const instanceId of ids) {
				// Boundary-anchored match: the instanceId must be a whole token in
				// the Dapr key — preceded by `||` (wfstate) or `_workflow_`
				// (agent_py_state) and followed by `||`, `__turn__` (turn
				// sub-instance), or end-of-key. A bare substring match would let a
				// deterministic id be a PREFIX of a sibling's: `..._run__1` would also
				// delete `..._run__10`/`..._run__11` state. agent_py_state lowercases
				// the id, so compare lowercased on both sides.
				const pattern = daprStateKeyMatchPattern(instanceId);
				try {
					await database.execute(sql`
						delete from ${sql.raw(table)}
						where lower(key) ~ ${pattern}
					`);
				} catch (err) {
					console.warn(
						`Failed to delete Dapr state rows from ${table} for ${instanceId}:`,
						err instanceof Error ? err.message : err,
					);
				}
			}
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
	const waitAgentRuntimeClosed = (runtimeAppId: string, instanceId: string) =>
		waitForDurableRuntimeClosedWithin(
			`agent runtime ${runtimeAppId}/${instanceId}`,
			() => getAgentRuntimeStatus(runtimeAppId, instanceId),
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
		sleep,
	};
}

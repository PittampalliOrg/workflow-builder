/**
 * Generic durable-workflow termination/purge cascade.
 *
 * This is the canonical, target-agnostic engine that stops a tree of Dapr
 * workflows (a parent orchestrator workflow + N per-session agent-runtime
 * `session_workflow` instances that each live under their own app-id) and
 * optionally purges their durable state. It was generalized from the
 * battle-tested benchmark cancellation cascade
 * (`src/lib/server/benchmarks/service.ts`), which now drives this engine via
 * `runDurableCascade`. Keep the two in sync — this is the single source of
 * truth for the algorithm.
 *
 * The engine is pure orchestration: every Dapr/HTTP/DB side effect is supplied
 * through the injected `DurableCascadeDeps`. Callers that don't need
 * benchmark-specific behavior should use `createDaprCascadeDeps()`.
 */
import { sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	daprFetch,
	getDaprSidecarUrl,
	getOrchestratorUrl,
} from "$lib/server/dapr-client";

export const DURABLE_RUNTIME_MISSING_STATUS = "__missing__";

export const TERMINAL_DURABLE_RUNTIME_STATUSES = new Set([
	"CANCELED",
	"CANCELLED",
	"COMPLETED",
	"FAILED",
	"TERMINATED",
]);

const DEFAULT_CASCADE_CONCURRENCY = 16;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
// In-request poll deadline for terminal status. A Dapr workflow blocked inside a
// long activity (e.g. a benchmark `solve`) only applies `terminate` once the
// activity yields, which can be minutes — so this window cannot guarantee
// in-request confirmation. Raised from the original 45s to cover the common
// slow-apply, and paired with the persisted stop-intent (202 "stopping") + the
// terminal-status reaper so the tail still converges. Overridable via
// LIFECYCLE_CASCADE_WAIT_SECONDS (wired by createDaprCascadeDeps callers).
const DEFAULT_WAIT_MS = 90_000;
const DEFAULT_WAIT_POLL_MS = 1_000;

export type AgentRuntimeTarget = {
	runtimeAppId: string;
	instanceId: string;
};

export type DurableTerminationResult =
	| "terminated"
	| "alreadyGone"
	| "closed"
	| "failed";

export type DurableGracefulCancellationResult =
	| "requested"
	| "alreadyGone"
	| "failed";

export type DurableCascadeResult = {
	allClosed: boolean;
	parentClosed: boolean;
	agentRuntimeClosed: boolean;
};

export type DurableCascadeDeps = {
	getParentStatus: (instanceId: string) => Promise<unknown>;
	cancelParent?: (
		instanceId: string,
		reason: string,
	) => Promise<DurableGracefulCancellationResult>;
	terminateParent: (
		instanceId: string,
		reason: string,
	) => Promise<DurableTerminationResult>;
	waitParentClosed: (instanceId: string) => Promise<boolean>;
	getAgentRuntimeStatus: (
		runtimeAppId: string,
		instanceId: string,
	) => Promise<unknown>;
	cancelAgentRuntime?: (
		runtimeAppId: string,
		instanceId: string,
		reason: string,
	) => Promise<DurableGracefulCancellationResult>;
	terminateAgentRuntime: (
		runtimeAppId: string,
		instanceId: string,
		reason: string,
	) => Promise<DurableTerminationResult>;
	waitAgentRuntimeClosed: (
		runtimeAppId: string,
		instanceId: string,
	) => Promise<boolean>;
	purgeParent: (instanceId: string) => Promise<void>;
	purgeAgentRuntime: (
		runtimeAppId: string,
		instanceId: string,
	) => Promise<void>;
	purgeStateRows?: (
		parentInstanceIds: string[],
		agentRuntimeTargets: AgentRuntimeTarget[],
		statePurgeInstanceIds?: string[],
	) => Promise<void>;
	sleep: (ms: number) => Promise<void>;
};

// ---------------------------------------------------------------------------
// Pure helpers (no side effects, no env coupling)
// ---------------------------------------------------------------------------

function errorText(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof Error) return `${input.name} ${input.message}`;
	if (input != null) {
		try {
			return JSON.stringify(input) ?? String(input);
		} catch {
			return String(input);
		}
	}
	return "";
}

export function isBenignDaprTerminationMiss(input: unknown): boolean {
	const normalized = errorText(input).toLowerCase();
	return (
		normalized.includes("no such instance exists") ||
		normalized.includes("agent run not found") ||
		normalized.includes("workflow instance not found") ||
		(normalized.includes("failed to resolve address") &&
			normalized.includes("no such host")) ||
		(normalized.includes("failed to invoke") &&
			normalized.includes("-dapr") &&
			normalized.includes("no such host"))
	);
}

export function isRecoverableDaprWorkflowTerminateError(input: unknown): boolean {
	const normalized = errorText(input).toLowerCase();
	return (
		normalized.includes("dapr workflow terminate failed with http 500") ||
		normalized.includes("dapr workflow terminate failed with http 503") ||
		normalized.includes("dapr workflow terminate failed with http 504")
	);
}

export function isTransientDaprServiceInvokeError(input: unknown): boolean {
	const normalized = errorText(input).toLowerCase();
	return (
		normalized.includes("err_direct_invoke") ||
		(normalized.includes("failed to invoke") &&
			(normalized.includes("connection reset by peer") ||
				normalized.includes("eof") ||
				normalized.includes("context deadline exceeded") ||
				normalized.includes("deadline exceeded"))) ||
		normalized.includes("app channel") ||
		normalized.includes("connection reset by peer")
	);
}

export function isTerminalDurableRuntimeStatus(status: unknown): boolean {
	return TERMINAL_DURABLE_RUNTIME_STATUSES.has(
		String(status ?? "").toUpperCase(),
	);
}

export function durableRuntimeStatusFromBody(body: unknown): unknown {
	if (!body || typeof body !== "object" || Array.isArray(body)) return null;
	const record = body as Record<string, unknown>;
	const direct =
		record.runtimeStatus ??
		record.runtime_status ??
		record.status ??
		record.workflowStatus ??
		null;
	if (direct && typeof direct === "object" && !Array.isArray(direct)) {
		return durableRuntimeStatusFromBody(direct);
	}
	return direct;
}

export async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runWithConcurrency<T>(
	items: T[],
	limit: number,
	worker: (item: T) => Promise<void>,
): Promise<void> {
	const pending = [...items];
	const concurrency = Math.max(1, Math.min(limit, pending.length));
	if (concurrency === 0) return;
	await Promise.all(
		Array.from({ length: concurrency }, async () => {
			while (pending.length > 0) {
				const item = pending.shift();
				if (item === undefined) return;
				await worker(item);
			}
		}),
	);
}

export async function waitForDurableRuntimeClosedWithin(
	label: string,
	fetchStatus: () => Promise<unknown>,
	waitMs: number,
	sleepFn: (ms: number) => Promise<void>,
	pollMs: number = DEFAULT_WAIT_POLL_MS,
): Promise<boolean> {
	if (waitMs <= 0) return false;
	const deadline = Date.now() + waitMs;
	let lastStatus: unknown = null;
	while (Date.now() < deadline) {
		const status = await fetchStatus().catch((err) => {
			if (isBenignDaprTerminationMiss(err)) {
				return DURABLE_RUNTIME_MISSING_STATUS;
			}
			console.warn(
				`Failed to poll ${label} shutdown status:`,
				err instanceof Error ? err.message : err,
			);
			return null;
		});
		if (
			status === DURABLE_RUNTIME_MISSING_STATUS ||
			isTerminalDurableRuntimeStatus(status)
		) {
			return true;
		}
		lastStatus = status;
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		await sleepFn(Math.min(pollMs, remaining));
	}
	console.warn(
		`Timed out waiting for ${label} to stop before purge${
			lastStatus ? ` (last status: ${String(lastStatus)})` : ""
		}`,
	);
	return false;
}

export function agentRuntimeTargetKey(target: AgentRuntimeTarget): string {
	return `${target.runtimeAppId}\0${target.instanceId}`;
}

export function dedupeAgentRuntimeTargets(
	targets: AgentRuntimeTarget[],
): AgentRuntimeTarget[] {
	const seen = new Set<string>();
	const deduped: AgentRuntimeTarget[] = [];
	for (const target of targets) {
		const runtimeAppId = target.runtimeAppId.trim();
		const instanceId = target.instanceId.trim();
		if (!runtimeAppId || !instanceId) continue;
		const key = agentRuntimeTargetKey({ runtimeAppId, instanceId });
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push({ runtimeAppId, instanceId });
	}
	return deduped;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export type RunDurableCascadeParams = {
	parentInstanceIds: string[];
	agentRuntimeTargets: AgentRuntimeTarget[];
	statePurgeInstanceIds?: string[];
	reason: string;
	purge: boolean;
	purgeGraceMs: number;
	forceStatePurgeOnUnclosed?: boolean;
	concurrency?: number;
	gracefulCancellationEnabled?: boolean;
	gracefulCancellationWaitMs?: number;
	deps: DurableCascadeDeps;
};

export async function runDurableCascade(
	params: RunDurableCascadeParams,
): Promise<DurableCascadeResult> {
	const deps = params.deps;
	const concurrency = params.concurrency ?? DEFAULT_CASCADE_CONCURRENCY;
	const gracefulCancellationEnabled =
		params.gracefulCancellationEnabled ?? false;
	const gracefulCancellationWaitMs = params.gracefulCancellationWaitMs ?? 0;
	const parentInstanceIds = [...new Set(params.parentInstanceIds.filter(Boolean))];
	const agentRuntimeTargets = dedupeAgentRuntimeTargets(
		params.agentRuntimeTargets,
	);
	const agentRuntimePreflightStatuses = new Map<string, unknown>();
	const agentRuntimeTerminations = new Map<string, DurableTerminationResult>();
	const parentTerminations = new Map<string, DurableTerminationResult>();
	const parentPreflightStatuses = new Map<string, unknown>();
	let parentClosed = true;
	let agentRuntimeClosed = true;

	await runWithConcurrency(parentInstanceIds, concurrency, async (instanceId) => {
		try {
			parentPreflightStatuses.set(instanceId, await deps.getParentStatus(instanceId));
		} catch (err) {
			console.warn(
				`Failed to preflight workflow status ${instanceId}:`,
				err instanceof Error ? err.message : err,
			);
			parentPreflightStatuses.set(instanceId, null);
		}
	});

	await runWithConcurrency(agentRuntimeTargets, concurrency, async (target) => {
		try {
			agentRuntimePreflightStatuses.set(
				agentRuntimeTargetKey(target),
				await deps.getAgentRuntimeStatus(target.runtimeAppId, target.instanceId),
			);
		} catch (err) {
			console.warn(
				`Failed to preflight agent runtime status ${target.runtimeAppId}/${target.instanceId}:`,
				err instanceof Error ? err.message : err,
			);
			agentRuntimePreflightStatuses.set(agentRuntimeTargetKey(target), null);
		}
	});

	let activeAgentRuntimeTargets = agentRuntimeTargets.filter((target) => {
		const key = agentRuntimeTargetKey(target);
		const preflightStatus = agentRuntimePreflightStatuses.get(key);
		if (preflightStatus === DURABLE_RUNTIME_MISSING_STATUS) {
			agentRuntimeTerminations.set(key, "alreadyGone");
			return false;
		}
		if (isTerminalDurableRuntimeStatus(preflightStatus)) {
			agentRuntimeTerminations.set(key, "terminated");
			return false;
		}
		return true;
	});

	const gracefulAgentRuntimeAttempted =
		activeAgentRuntimeTargets.length > 0 &&
		gracefulCancellationEnabled &&
		gracefulCancellationWaitMs > 0 &&
		typeof deps.cancelAgentRuntime === "function";
	if (gracefulAgentRuntimeAttempted) {
		await runWithConcurrency(
			activeAgentRuntimeTargets,
			concurrency,
			async (target) => {
				const result = await deps.cancelAgentRuntime?.(
					target.runtimeAppId,
					target.instanceId,
					params.reason,
				);
				if (result === "alreadyGone") {
					agentRuntimeTerminations.set(agentRuntimeTargetKey(target), "alreadyGone");
				}
			},
		);
		await runWithConcurrency(
			activeAgentRuntimeTargets,
			concurrency,
			async (target) => {
				const key = agentRuntimeTargetKey(target);
				if (agentRuntimeTerminations.get(key) === "alreadyGone") return;
				const closed = await waitForDurableRuntimeClosedWithin(
					`agent runtime graceful cancel ${target.runtimeAppId}/${target.instanceId}`,
					() => deps.getAgentRuntimeStatus(target.runtimeAppId, target.instanceId),
					gracefulCancellationWaitMs,
					deps.sleep,
				);
				if (closed) agentRuntimeTerminations.set(key, "closed");
			},
		);
		activeAgentRuntimeTargets = activeAgentRuntimeTargets.filter((target) => {
			const termination = agentRuntimeTerminations.get(agentRuntimeTargetKey(target));
			return (
				termination !== "alreadyGone" &&
				termination !== "terminated" &&
				termination !== "closed"
			);
		});
	}

	await runWithConcurrency(activeAgentRuntimeTargets, concurrency, async (target) => {
		const key = agentRuntimeTargetKey(target);
		if (gracefulAgentRuntimeAttempted) {
			try {
				const status = await deps.getAgentRuntimeStatus(
					target.runtimeAppId,
					target.instanceId,
				);
				if (status === DURABLE_RUNTIME_MISSING_STATUS) {
					agentRuntimeTerminations.set(key, "alreadyGone");
					return;
				}
				if (isTerminalDurableRuntimeStatus(status)) {
					agentRuntimeTerminations.set(key, "terminated");
					return;
				}
			} catch (err) {
				console.warn(
					`Failed to re-check agent runtime status ${target.runtimeAppId}/${target.instanceId}:`,
					err instanceof Error ? err.message : err,
				);
			}
		}
		const termination = await deps.terminateAgentRuntime(
			target.runtimeAppId,
			target.instanceId,
			params.reason,
		);
		agentRuntimeTerminations.set(key, termination);
		if (termination === "failed") {
			agentRuntimeClosed = false;
		}
	});

	await runWithConcurrency(agentRuntimeTargets, concurrency, async (target) => {
		const key = agentRuntimeTargetKey(target);
		const termination = agentRuntimeTerminations.get(key) ?? "terminated";
		if (termination === "failed") {
			agentRuntimeClosed = false;
			return;
		}
		const closed =
			termination === "alreadyGone" ||
			termination === "closed" ||
			(await deps.waitAgentRuntimeClosed(target.runtimeAppId, target.instanceId));
		if (!closed) {
			agentRuntimeClosed = false;
		}
	});

	let activeParentInstanceIds = parentInstanceIds.filter((instanceId) => {
		const status = parentPreflightStatuses.get(instanceId);
		if (status === DURABLE_RUNTIME_MISSING_STATUS) {
			parentTerminations.set(instanceId, "alreadyGone");
			return false;
		}
		if (isTerminalDurableRuntimeStatus(status)) {
			parentTerminations.set(instanceId, "terminated");
			return false;
		}
		return true;
	});

	if (activeParentInstanceIds.length > 0) {
		const gracefulParentAttempted =
			gracefulCancellationEnabled &&
			gracefulCancellationWaitMs > 0 &&
			typeof deps.cancelParent === "function";
		if (gracefulParentAttempted) {
			await runWithConcurrency(
				activeParentInstanceIds,
				concurrency,
				async (instanceId) => {
					const result = await deps.cancelParent?.(instanceId, params.reason);
					if (result === "alreadyGone") {
						parentTerminations.set(instanceId, "alreadyGone");
					}
				},
			);
			await runWithConcurrency(
				activeParentInstanceIds,
				concurrency,
				async (instanceId) => {
					if (parentTerminations.get(instanceId) === "alreadyGone") return;
					const closed = await waitForDurableRuntimeClosedWithin(
						`workflow graceful cancel ${instanceId}`,
						() => deps.getParentStatus(instanceId),
						gracefulCancellationWaitMs,
						deps.sleep,
					);
					if (closed) parentTerminations.set(instanceId, "closed");
				},
			);
			activeParentInstanceIds = activeParentInstanceIds.filter((instanceId) => {
				const termination = parentTerminations.get(instanceId);
				return (
					termination !== "alreadyGone" &&
					termination !== "terminated" &&
					termination !== "closed"
				);
			});
		}

		await runWithConcurrency(activeParentInstanceIds, concurrency, async (instanceId) => {
			if (gracefulParentAttempted) {
				try {
					const status = await deps.getParentStatus(instanceId);
					if (status === DURABLE_RUNTIME_MISSING_STATUS) {
						parentTerminations.set(instanceId, "alreadyGone");
						return;
					}
					if (isTerminalDurableRuntimeStatus(status)) {
						parentTerminations.set(instanceId, "terminated");
						return;
					}
				} catch (err) {
					console.warn(
						`Failed to re-check workflow status ${instanceId}:`,
						err instanceof Error ? err.message : err,
					);
				}
			}
			const termination = await deps.terminateParent(instanceId, params.reason);
			parentTerminations.set(instanceId, termination);
			if (termination === "failed") {
				parentClosed = false;
			}
		});

		await runWithConcurrency(activeParentInstanceIds, concurrency, async (instanceId) => {
			const termination = parentTerminations.get(instanceId) ?? "terminated";
			if (termination === "failed") {
				parentClosed = false;
				return;
			}
			const closed =
				termination === "alreadyGone" ||
				termination === "closed" ||
				(await deps.waitParentClosed(instanceId));
			if (!closed) {
				parentClosed = false;
			}
		});

		if (!parentClosed) {
			parentClosed = true;
			await runWithConcurrency(
				activeParentInstanceIds,
				concurrency,
				async (instanceId) => {
					let status: unknown = null;
					try {
						status = await deps.getParentStatus(instanceId);
					} catch (err) {
						console.warn(
							`Failed to re-check workflow status ${instanceId}:`,
							err instanceof Error ? err.message : err,
						);
					}
					if (
						status === DURABLE_RUNTIME_MISSING_STATUS ||
						isTerminalDurableRuntimeStatus(status)
					) {
						return;
					}
					const termination = await deps.terminateParent(instanceId, params.reason);
					if (termination === "failed") {
						parentClosed = false;
						return;
					}
					const closed =
						termination === "alreadyGone" ||
						(await deps.waitParentClosed(instanceId));
					if (!closed) {
						parentClosed = false;
					}
				},
			);
		}
	}

	const allClosed = parentClosed && agentRuntimeClosed;
	if (!allClosed && params.purge && params.forceStatePurgeOnUnclosed) {
		console.warn(
			"Durable cleanup did not observe terminal Dapr status after termination; force-deleting scoped Dapr state rows",
		);
		await deps.purgeStateRows?.(
			parentInstanceIds,
			agentRuntimeTargets,
			params.statePurgeInstanceIds,
		);
		return { allClosed: true, parentClosed: true, agentRuntimeClosed: true };
	}
	if (!allClosed || !params.purge) {
		return { allClosed, parentClosed, agentRuntimeClosed };
	}

	if (params.purgeGraceMs > 0) {
		await deps.sleep(params.purgeGraceMs);
	}
	await runWithConcurrency(agentRuntimeTargets, concurrency, async (target) => {
		await deps.purgeAgentRuntime(target.runtimeAppId, target.instanceId);
	});
	await runWithConcurrency(parentInstanceIds, concurrency, async (instanceId) => {
		await deps.purgeParent(instanceId);
	});
	await deps.purgeStateRows?.(
		parentInstanceIds,
		agentRuntimeTargets,
		params.statePurgeInstanceIds,
	);
	return { allClosed, parentClosed, agentRuntimeClosed };
}

// ---------------------------------------------------------------------------
// Default generic Dapr-backed deps (used by the lifecycle controller)
// ---------------------------------------------------------------------------

const DAPR_STATE_ROW_TABLES = ["wfstate_state", "agent_py_state"] as const;

export type CreateDaprCascadeDepsOptions = {
	requestTimeoutMs?: number;
	waitMs?: number;
	waitPollMs?: number;
};

/**
 * Build a {@link DurableCascadeDeps} that talks to the orchestrator + per-session
 * agent runtimes over Dapr (the same wire calls the benchmark cascade makes).
 */
export function createDaprCascadeDeps(
	opts: CreateDaprCascadeDepsOptions = {},
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
				if (isBenignDaprTerminationMiss(detail)) return DURABLE_RUNTIME_MISSING_STATUS;
				if (isTransientDaprServiceInvokeError(detail)) return null;
				throw new Error(
					`status request failed with ${res.status}${detail ? `: ${detail}` : ""}`,
				);
			}
			return durableRuntimeStatusFromBody(await res.json().catch(() => null));
		} catch (err) {
			if (isBenignDaprTerminationMiss(err)) return DURABLE_RUNTIME_MISSING_STATUS;
			if (isTransientDaprServiceInvokeError(err)) return null;
			throw err;
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
				if (isBenignDaprTerminationMiss(detail)) return DURABLE_RUNTIME_MISSING_STATUS;
				if (isTransientDaprServiceInvokeError(detail)) return null;
				throw new Error(
					`status request failed with ${res.status}${detail ? `: ${detail}` : ""}`,
				);
			}
			return durableRuntimeStatusFromBody(await res.json().catch(() => null));
		} catch (err) {
			if (isBenignDaprTerminationMiss(err)) return DURABLE_RUNTIME_MISSING_STATUS;
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
						eventData: { reason, source: "lifecycle_controller", cancelledAt: new Date().toISOString() },
					}),
					maxRetries: 0,
					signal: AbortSignal.timeout(requestTimeoutMs),
				},
			);
			if (!res.ok) {
				const detail = await res.text().catch(() => "");
				if (res.status === 404 || isBenignDaprTerminationMiss(detail)) return "alreadyGone";
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
						payload: { reason, source: "lifecycle_controller", cancelledAt: new Date().toISOString() },
					}),
					maxRetries: 0,
					signal: AbortSignal.timeout(requestTimeoutMs),
				},
			);
			if (!res.ok) {
				const detail = await res.text().catch(() => "");
				if (res.status === 404 || isBenignDaprTerminationMiss(detail)) return "alreadyGone";
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
				if (res.status === 404 || isBenignDaprTerminationMiss(detail)) return "alreadyGone";
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
			if (isRecoverableDaprWorkflowTerminateError(err) || isTransientDaprServiceInvokeError(err)) {
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
				if (res.status === 404 || isBenignDaprTerminationMiss(detail)) return "alreadyGone";
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
			if (isRecoverableDaprWorkflowTerminateError(err) || isTransientDaprServiceInvokeError(err)) {
				return "terminated";
			}
			return "failed";
		}
	}

	async function purgeParent(instanceId: string): Promise<void> {
		try {
			const res = await daprFetch(
				`${getOrchestratorUrl()}/api/v2/workflows/${encodeURIComponent(instanceId)}?recursive=true`,
				{ method: "DELETE", signal: AbortSignal.timeout(requestTimeoutMs), maxRetries: 0 },
			);
			if (!res.ok) {
				const detail = await res.text().catch(() => "");
				if (res.status === 404 || isBenignDaprTerminationMiss(detail)) return;
				console.warn(`Failed to purge workflow ${instanceId}: ${res.status} ${detail}`);
			}
		} catch (err) {
			if (isBenignDaprTerminationMiss(err)) return;
			console.warn(`Failed to purge workflow ${instanceId}:`, err instanceof Error ? err.message : err);
		}
	}

	async function purgeAgentRuntime(runtimeAppId: string, instanceId: string): Promise<void> {
		try {
			const res = await daprFetch(
				`${getDaprSidecarUrl()}/v1.0/invoke/${encodeURIComponent(runtimeAppId)}/method/api/v2/agent-runs/${encodeURIComponent(instanceId)}?recursive=true`,
				{ method: "DELETE", signal: AbortSignal.timeout(requestTimeoutMs), maxRetries: 0 },
			);
			if (!res.ok) {
				const detail = await res.text().catch(() => "");
				if (res.status === 404 || isBenignDaprTerminationMiss(detail)) return;
				console.warn(`Failed to purge agent runtime ${runtimeAppId}/${instanceId}: ${res.status} ${detail}`);
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
		if (ids.size === 0 || !db) return;
		for (const table of DAPR_STATE_ROW_TABLES) {
			for (const instanceId of ids) {
				try {
					await db.execute(sql`
						delete from ${sql.raw(table)}
						where position(${instanceId} in key) > 0
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

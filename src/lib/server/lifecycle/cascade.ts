/**
 * Generic durable-workflow termination/purge cascade.
 *
 * This is the canonical, target-agnostic engine that stops a tree of Dapr
 * workflows (a parent orchestrator workflow + N per-session agent-runtime
 * `session_workflow` instances that each live under their own app-id) and
 * optionally purges their durable state. It was generalized from the
 * battle-tested benchmark cancellation cascade
 * (`src/lib/server/application/adapters/benchmark-service.ts`), which drives this engine via
 * `runDurableCascade`. Keep the two in sync — this is the single source of
 * truth for the algorithm.
 *
 * The engine is pure orchestration: every Dapr/HTTP/DB side effect is supplied
 * through the injected `DurableCascadeDeps`. Callers that don't need
 * benchmark-specific behavior should use the Dapr-backed adapter in
 * `src/lib/server/application/adapters/lifecycle-cascade.ts`.
 */

export const DURABLE_RUNTIME_MISSING_STATUS = "__missing__";

export const TERMINAL_DURABLE_RUNTIME_STATUSES = new Set([
	"CANCELED",
	"CANCELLED",
	"COMPLETED",
	"FAILED",
	"TERMINATED",
]);

const DEFAULT_CASCADE_CONCURRENCY = 16;
// In-request poll deadline for terminal status. A Dapr workflow blocked inside a
// long activity (e.g. a benchmark `solve`) only applies `terminate` once the
// activity yields, which can be minutes — so this window cannot guarantee
// in-request confirmation. Raised from the original 45s to cover the common
// slow-apply, and paired with the persisted stop-intent (202 "stopping") + the
// explicit stop/status confirmation path so the tail still converges. Overridable via
// LIFECYCLE_CASCADE_WAIT_SECONDS (wired by Dapr cascade adapter callers).
const DEFAULT_WAIT_MS = 90_000;
const DEFAULT_WAIT_POLL_MS = 1_000;

export type AgentRuntimeTarget = {
	runtimeAppId: string;
	instanceId: string;
  runtimeSandboxName?: string | null;
	/** False for a native peer that routes through a parent-owned host. */
	ownsRuntimeSandbox?: boolean;
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
	/**
	 * The parent orchestration's live `currentNodeId` (the SW node it is parked
	 * on), or null if unavailable/terminal. Positive evidence for the cross-app
	 * wedge gate. Optional — benchmark deps don't supply it.
	 */
	getParentCurrentNode?: (instanceId: string) => Promise<string | null>;
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
    runtimeSandboxName?: string | null,
	) => Promise<unknown>;
	cancelAgentRuntime?: (
		runtimeAppId: string,
		instanceId: string,
		reason: string,
    runtimeSandboxName?: string | null,
	) => Promise<DurableGracefulCancellationResult>;
	terminateAgentRuntime: (
		runtimeAppId: string,
		instanceId: string,
		reason: string,
    runtimeSandboxName?: string | null,
	) => Promise<DurableTerminationResult>;
	waitAgentRuntimeClosed: (
		runtimeAppId: string,
		instanceId: string,
    runtimeSandboxName?: string | null,
	) => Promise<boolean>;
	purgeParent: (instanceId: string) => Promise<void>;
	purgeAgentRuntime: (
		runtimeAppId: string,
		instanceId: string,
    runtimeSandboxName?: string | null,
	) => Promise<void>;
	purgeStateRows?: (
		parentInstanceIds: string[],
		agentRuntimeTargets: AgentRuntimeTarget[],
		statePurgeInstanceIds?: string[],
	) => Promise<void>;
	/** Strictly delete one exact owned per-session runtime target through its provider. */
	deleteRuntimeSandbox?: (target: {
		runtimeAppId: string;
		runtimeSandboxName: string;
	}) => Promise<void>;
  /** Strictly delete one per-session OpenShell Sandbox by its actual name. */
  deleteWorkspaceSandbox?: (sandboxName: string) => Promise<void>;
  /** Strictly clean workflow-owned OpenShell workspaces by execution scope. */
  cleanupWorkspaceExecution?: (executionId: string) => Promise<void>;
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

export function isRecoverableDaprWorkflowTerminateError(
  input: unknown,
): boolean {
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

/**
 * Decide whether a Stop has hit the cross-app child wedge and should be
 * force-finalized — evaluated for a still-RUNNING parent. The SW-interpreter
 * parent dispatches each `durable/run` step as a per-session agent child via
 * ctx.call_child_workflow(app_id=…) — a sub-orchestration on a SEPARATE Dapr task
 * hub that Dapr's recursive terminate can't reach, so the parent can hang RUNNING
 * even after the cascade terminated (or the liveness reconciler crash-finalized)
 * the child.
 *
 * Force-finalize is a pure DB-state cleanup of a run the user ALREADY asked to
 * stop, so we require POSITIVE evidence the whole agent side is dead — never an
 * inferred boolean:
 *   1. a stop was actually requested and {@link WEDGE_FINALIZE_GRACE_MS} has
 *      elapsed since — long enough for any normally-terminable parent to have
 *      applied the terminate the cascade issued, so a run still RUNNING past it is
 *      genuinely wedged rather than merely slow; AND
 *   2. at least one `durable/run` child node is DB-terminal — every run-index
 *      child of it `terminated` OR crash-`failed`+completedAt (in
 *      `terminatedChildNodes`); without a dead agent child there is no cross-app
 *      wedge to clean up; AND
 *   3. NO child is still active ANYWHERE (`activeChildNodes` empty).
 *
 * (3) is the ABSOLUTE safety guard: a parent with ANY live cross-app child is
 * NEVER force-finalized here. It may legitimately be awaiting/progressing that
 * child — e.g. it crashed an EARLIER `durable/run` branch and ADVANCED to a later
 * one that is now genuinely running — so we leave the live child to the cascade +
 * cooperative cancel and let the normal parent+child-closed path finalize.
 *
 * Crucially this NO LONGER requires the parent's live `currentNodeId` to still
 * match the dead child's node. The earlier cut did, which left a real class of
 * wedge un-finalizable: a parent whose `durable/run` child was crash-finalized
 * out-of-band (liveness reconciler → session `failed`+completedAt) while the
 * parent's currentNodeId ADVANCED to a LATER approval-gate / non-agent node — the
 * node no longer matched the terminated child, so `shouldForceFinalizeCrossAppWedge`
 * never fired and the Stop polled "stopping" FOREVER. The child-evidence rule
 * (2)+(3) covers that advanced-node case while (3) preserves the conservatism the
 * old node-match provided. The old loop-nesting subtlety is subsumed: loop-nested
 * children (`refine-generate-0-`, `refine-evaluate-0-`) already appear in
 * `terminatedChildNodes`/`activeChildNodes` directly, so a mid-iteration loop is
 * still protected by (3). `parentCurrentNode` is retained only for the caller's
 * diagnostic log; it no longer gates the decision. The caller passes only a parent
 * NOT closed (still RUNNING per Dapr).
 */
export function shouldForceFinalizeCrossAppWedge(params: {
	stopRequestedAt: Date | null;
	nowMs: number;
	graceMs: number;
	parentCurrentNode: string | null;
	terminatedChildNodes: string[];
	activeChildNodes?: string[];
}): boolean {
	if (
		params.stopRequestedAt == null ||
		params.nowMs - params.stopRequestedAt.getTime() < params.graceMs
	) {
		return false;
	}
	const hasTerminatedChild = params.terminatedChildNodes.length > 0;
	const hasActiveChildAnywhere = (params.activeChildNodes ?? []).length > 0;
	return hasTerminatedChild && !hasActiveChildAnywhere;
}

/**
 * POSIX-regex pattern matching every Dapr state-store key that belongs to a
 * durable instance — and ONLY that instance. The id must be a whole token:
 * preceded by `||` (wfstate_state) or `_workflow_` (agent_py_state) and followed
 * by `||`, `__turn__` (turn sub-instance), or end-of-key. This is what stops a
 * deterministic id from matching a sibling as a prefix (`…_run__1` ⊄ `…_run__10`).
 * Lowercased because agent_py_state lowercases the embedded id; callers compare
 * `lower(key) ~ pattern`.
 */
export function daprStateKeyMatchPattern(instanceId: string): string {
	const idRe = instanceId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return `(\\|\\||_workflow_)${idRe}(\\|\\||__turn__|$)`.toLowerCase();
}

export function dedupeAgentRuntimeTargets(
	targets: AgentRuntimeTarget[],
): AgentRuntimeTarget[] {
  const seen = new Map<string, number>();
	const deduped: AgentRuntimeTarget[] = [];
	for (const target of targets) {
		const runtimeAppId = target.runtimeAppId.trim();
		const instanceId = target.instanceId.trim();
    const runtimeSandboxName = target.runtimeSandboxName?.trim() || null;
		if (!runtimeAppId || !instanceId) continue;
		const key = agentRuntimeTargetKey({ runtimeAppId, instanceId });
    const existingIndex = seen.get(key);
    if (existingIndex !== undefined) {
      const existing = deduped[existingIndex];
      if (existing && !existing.runtimeSandboxName && runtimeSandboxName) {
        deduped[existingIndex] = {
          ...existing,
          runtimeSandboxName,
        };
      }
      continue;
    }
    seen.set(key, deduped.length);
    deduped.push(
      target.runtimeSandboxName === undefined
        ? { runtimeAppId, instanceId }
        : { runtimeAppId, instanceId, runtimeSandboxName },
    );
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
  const parentInstanceIds = [
    ...new Set(params.parentInstanceIds.filter(Boolean)),
  ];
	const agentRuntimeTargets = dedupeAgentRuntimeTargets(
		params.agentRuntimeTargets,
	);
	const agentRuntimePreflightStatuses = new Map<string, unknown>();
	const agentRuntimeTerminations = new Map<string, DurableTerminationResult>();
	const parentTerminations = new Map<string, DurableTerminationResult>();
	const parentPreflightStatuses = new Map<string, unknown>();
	let parentClosed = true;
	let agentRuntimeClosed = true;

  await runWithConcurrency(
    parentInstanceIds,
    concurrency,
    async (instanceId) => {
		try {
        parentPreflightStatuses.set(
          instanceId,
          await deps.getParentStatus(instanceId),
        );
		} catch (err) {
			console.warn(
				`Failed to preflight workflow status ${instanceId}:`,
				err instanceof Error ? err.message : err,
			);
			parentPreflightStatuses.set(instanceId, null);
		}
    },
  );

	await runWithConcurrency(agentRuntimeTargets, concurrency, async (target) => {
		try {
			agentRuntimePreflightStatuses.set(
				agentRuntimeTargetKey(target),
        await deps.getAgentRuntimeStatus(
          target.runtimeAppId,
          target.instanceId,
          target.runtimeSandboxName,
        ),
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

	const gracefulParentAttempted =
		activeParentInstanceIds.length > 0 &&
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
	}

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
          target.runtimeSandboxName,
				);
				if (result === "alreadyGone") {
          agentRuntimeTerminations.set(
            agentRuntimeTargetKey(target),
            "alreadyGone",
          );
				}
			},
		);
	}

	if (gracefulAgentRuntimeAttempted) {
		await runWithConcurrency(
			activeAgentRuntimeTargets,
			concurrency,
			async (target) => {
				const key = agentRuntimeTargetKey(target);
				if (agentRuntimeTerminations.get(key) === "alreadyGone") return;
				const closed = await waitForDurableRuntimeClosedWithin(
					`agent runtime graceful cancel ${target.runtimeAppId}/${target.instanceId}`,
          () =>
            deps.getAgentRuntimeStatus(
              target.runtimeAppId,
              target.instanceId,
              target.runtimeSandboxName,
            ),
					gracefulCancellationWaitMs,
					deps.sleep,
				);
				if (closed) agentRuntimeTerminations.set(key, "closed");
			},
		);
		activeAgentRuntimeTargets = activeAgentRuntimeTargets.filter((target) => {
      const termination = agentRuntimeTerminations.get(
        agentRuntimeTargetKey(target),
      );
			return (
				termination !== "alreadyGone" &&
				termination !== "terminated" &&
				termination !== "closed"
			);
		});
	}

  await runWithConcurrency(
    activeAgentRuntimeTargets,
    concurrency,
    async (target) => {
		const key = agentRuntimeTargetKey(target);
		if (gracefulAgentRuntimeAttempted) {
			try {
				const status = await deps.getAgentRuntimeStatus(
					target.runtimeAppId,
					target.instanceId,
            target.runtimeSandboxName,
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
        target.runtimeSandboxName,
		);
		agentRuntimeTerminations.set(key, termination);
		if (termination === "failed") {
			agentRuntimeClosed = false;
		}
    },
  );

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
      (await deps.waitAgentRuntimeClosed(
        target.runtimeAppId,
        target.instanceId,
        target.runtimeSandboxName,
      ));
		if (!closed) {
			agentRuntimeClosed = false;
		}
	});

	if (activeParentInstanceIds.length > 0) {
		if (gracefulParentAttempted) {
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

    await runWithConcurrency(
      activeParentInstanceIds,
      concurrency,
      async (instanceId) => {
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
        const termination = await deps.terminateParent(
          instanceId,
          params.reason,
        );
			parentTerminations.set(instanceId, termination);
			if (termination === "failed") {
				parentClosed = false;
			}
      },
    );

    await runWithConcurrency(
      activeParentInstanceIds,
      concurrency,
      async (instanceId) => {
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
      },
    );

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
          const termination = await deps.terminateParent(
            instanceId,
            params.reason,
          );
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
    await deps.purgeAgentRuntime(
      target.runtimeAppId,
      target.instanceId,
      target.runtimeSandboxName,
    );
	});
  await runWithConcurrency(
    parentInstanceIds,
    concurrency,
    async (instanceId) => {
		await deps.purgeParent(instanceId);
    },
  );
	await deps.purgeStateRows?.(
		parentInstanceIds,
		agentRuntimeTargets,
		params.statePurgeInstanceIds,
	);
	return { allClosed, parentClosed, agentRuntimeClosed };
}

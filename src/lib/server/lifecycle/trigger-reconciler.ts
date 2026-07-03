/**
 * Trigger activation reconciler — drives a workflow trigger through its
 * lifecycle (inactive -> activating -> active -> deactivating -> inactive),
 * provisioning / tearing down the backing resource (Argo EventSource+Sensor
 * today; Dapr Job/Subscription/binding in P5/P6). Mirrors the lifecycle
 * controller's mark-intent -> act -> confirm shape.
 */
import { getTriggerKind } from "$lib/server/workflows/trigger-registry";
import { provisionBacking, deprovisionBacking } from "$lib/server/lifecycle/trigger-backings";
import type {
	WorkflowTriggerLifecyclePort,
	WorkflowTriggerStatus,
	WorkflowTriggerStore,
} from "$lib/server/application/ports";

export type TriggerActionResult = { ok: true; status: string } | { ok: false; error: string };

type TriggerStorePort = Pick<WorkflowTriggerStore, "getById" | "updateLifecycleState">;

export type TriggerBackingPort = {
	provision(input: {
		triggerId: string;
		workflowId: string;
		kind: string;
		config: Record<string, unknown>;
		backingRef: string | null;
	}): Promise<{
		backingRef?: string | null;
		configPatch?: Record<string, unknown>;
	}>;
	deprovision(input: { triggerId: string; kind: string; backingRef: string | null }): Promise<void>;
};

const defaultBackingPort: TriggerBackingPort = {
	provision: provisionBacking,
	deprovision: deprovisionBacking,
};

export class WorkflowTriggerLifecycleReconciler implements WorkflowTriggerLifecyclePort {
	constructor(
		private readonly deps: {
			triggers: TriggerStorePort;
			backing?: TriggerBackingPort;
		},
	) {}

	activateTrigger(triggerId: string): Promise<TriggerActionResult> {
		return activateWorkflowTrigger(triggerId, this.deps);
	}

	deactivateTrigger(triggerId: string): Promise<TriggerActionResult> {
		return deactivateWorkflowTrigger(triggerId, this.deps);
	}
}

export async function activateWorkflowTrigger(
	triggerId: string,
	deps: { triggers: TriggerStorePort; backing?: TriggerBackingPort },
): Promise<TriggerActionResult> {
	const row = await deps.triggers.getById(triggerId);
	if (!row) return { ok: false, error: "Trigger not found" };

	const kind = getTriggerKind(row.kind);
	if (!kind) return { ok: false, error: `Unknown trigger kind: ${row.kind}` };

	// Kinds that don't provision a listener (manual/mcp) are "active" as soon as
	// they're configured — no backing to reconcile.
	if (!kind.requiresActivation) {
		await setStatus(deps.triggers, triggerId, "active", { lastError: null });
		return { ok: true, status: "active" };
	}

	await setStatus(deps.triggers, triggerId, "activating");
	try {
		const { backingRef, configPatch } = await (deps.backing ?? defaultBackingPort).provision({
			triggerId: row.id,
			workflowId: row.workflowId,
			kind: row.kind,
			config: (row.config ?? {}) as Record<string, unknown>,
			backingRef: row.backingRef,
		});
		// Persist any backing-produced config (e.g. the encrypted HMAC secret).
		const mergedConfig = configPatch
			? { ...((row.config ?? {}) as Record<string, unknown>), ...configPatch }
			: undefined;
		await setStatus(deps.triggers, triggerId, "active", {
			backingRef,
			lastError: null,
			...(mergedConfig ? { config: mergedConfig } : {}),
		});
		return { ok: true, status: "active" };
	} catch (err) {
		const error = err instanceof Error ? err.message : "activation failed";
		await setStatus(deps.triggers, triggerId, "error", { lastError: error });
		return { ok: false, error };
	}
}

export async function deactivateWorkflowTrigger(
	triggerId: string,
	deps: { triggers: TriggerStorePort; backing?: TriggerBackingPort },
): Promise<TriggerActionResult> {
	const row = await deps.triggers.getById(triggerId);
	if (!row) return { ok: false, error: "Trigger not found" };

	const kind = getTriggerKind(row.kind);
	if (kind && !kind.requiresActivation) {
		await setStatus(deps.triggers, triggerId, "inactive");
		return { ok: true, status: "inactive" };
	}

	await setStatus(deps.triggers, triggerId, "deactivating");
	try {
		await (deps.backing ?? defaultBackingPort).deprovision({
			triggerId: row.id,
			kind: row.kind,
			backingRef: row.backingRef,
		});
		await setStatus(deps.triggers, triggerId, "inactive", {
			backingRef: null,
			lastError: null,
		});
		return { ok: true, status: "inactive" };
	} catch (err) {
		const error = err instanceof Error ? err.message : "deactivation failed";
		await setStatus(deps.triggers, triggerId, "error", { lastError: error });
		return { ok: false, error };
	}
}

async function setStatus(
	triggers: TriggerStorePort,
	triggerId: string,
	status: WorkflowTriggerStatus,
	extra: {
		backingRef?: string | null;
		lastError?: string | null;
		config?: Record<string, unknown>;
	} = {},
): Promise<void> {
	await triggers.updateLifecycleState({
		triggerId,
		status,
		...extra,
	});
}

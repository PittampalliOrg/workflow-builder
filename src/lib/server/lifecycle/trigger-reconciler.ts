/**
 * Trigger activation reconciler — drives a workflow_triggers row through its
 * lifecycle (inactive → activating → active → deactivating → inactive), provisioning
 * / tearing down the backing resource (Argo EventSource+Sensor today; Dapr
 * Job/Subscription/binding in P5/P6). Mirrors the lifecycle controller's
 * mark-intent → act → confirm shape (src/lib/server/lifecycle/index.ts).
 */
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { workflowTriggers } from '$lib/server/db/schema';
import { getTriggerKind } from '$lib/server/workflows/trigger-registry';
import { provisionBacking, deprovisionBacking } from '$lib/server/lifecycle/trigger-backings';

export type TriggerActionResult = { ok: true; status: string } | { ok: false; error: string };

async function setStatus(
	id: string,
	status: string,
	extra: Partial<typeof workflowTriggers.$inferInsert> = {}
): Promise<void> {
	if (!db) return;
	await db
		.update(workflowTriggers)
		.set({ status: status as never, updatedAt: new Date(), ...extra })
		.where(eq(workflowTriggers.id, id));
}

export async function activateWorkflowTrigger(triggerId: string): Promise<TriggerActionResult> {
	if (!db) return { ok: false, error: 'Database not configured' };
	const [row] = await db.select().from(workflowTriggers).where(eq(workflowTriggers.id, triggerId)).limit(1);
	if (!row) return { ok: false, error: 'Trigger not found' };

	const kind = getTriggerKind(row.kind);
	if (!kind) return { ok: false, error: `Unknown trigger kind: ${row.kind}` };

	// Kinds that don't provision a listener (manual/mcp) are "active" as soon as
	// they're configured — no backing to reconcile.
	if (!kind.requiresActivation) {
		await setStatus(triggerId, 'active', { lastError: null });
		return { ok: true, status: 'active' };
	}

	await setStatus(triggerId, 'activating');
	try {
		const { backingRef, configPatch } = await provisionBacking({
			triggerId: row.id,
			workflowId: row.workflowId,
			kind: row.kind,
			config: (row.config ?? {}) as Record<string, unknown>,
			backingRef: row.backingRef
		});
		// Persist any backing-produced config (e.g. the encrypted HMAC secret).
		const mergedConfig = configPatch
			? { ...((row.config ?? {}) as Record<string, unknown>), ...configPatch }
			: undefined;
		await setStatus(triggerId, 'active', {
			backingRef,
			lastError: null,
			...(mergedConfig ? { config: mergedConfig } : {})
		});
		return { ok: true, status: 'active' };
	} catch (err) {
		const error = err instanceof Error ? err.message : 'activation failed';
		await setStatus(triggerId, 'error', { lastError: error });
		return { ok: false, error };
	}
}

export async function deactivateWorkflowTrigger(triggerId: string): Promise<TriggerActionResult> {
	if (!db) return { ok: false, error: 'Database not configured' };
	const [row] = await db.select().from(workflowTriggers).where(eq(workflowTriggers.id, triggerId)).limit(1);
	if (!row) return { ok: false, error: 'Trigger not found' };

	const kind = getTriggerKind(row.kind);
	if (kind && !kind.requiresActivation) {
		await setStatus(triggerId, 'inactive');
		return { ok: true, status: 'inactive' };
	}

	await setStatus(triggerId, 'deactivating');
	try {
		await deprovisionBacking({ triggerId: row.id, kind: row.kind, backingRef: row.backingRef });
		await setStatus(triggerId, 'inactive', { backingRef: null, lastError: null });
		return { ok: true, status: 'inactive' };
	} catch (err) {
		const error = err instanceof Error ? err.message : 'deactivation failed';
		await setStatus(triggerId, 'error', { lastError: error });
		return { ok: false, error };
	}
}

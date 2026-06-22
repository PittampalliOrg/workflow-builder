/**
 * App-level concurrency gate for event-triggered workflow runs.
 *
 * Capacity is mediated at THREE layers (docs/event-driven-workflow-triggers.md):
 *   1. this app-level gate — source backpressure + a defer signal + dedup;
 *   2. Dapr 1.18 `workflowConcurrencyLimits` — replica-correct instance ceiling;
 *   3. the dedicated `event-triggered` Kueue queue + PSI — the actual pods/memory.
 *
 * This module is layer 1: it counts currently-running runs that were started by a
 * trigger (`workflow_executions.trigger_source IS NOT NULL`) and, over the cap,
 * tells the trigger handler to DEFER (NACK → JetStream redelivers later).
 */
import { and, isNotNull, inArray, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { workflowExecutions } from '$lib/server/db/schema';
import { env } from '$env/dynamic/private';

/** Statuses that count as a live/active triggered run holding a concurrency slot. */
const ACTIVE_STATUSES = ['running', 'pending'] as const;

export function triggerConcurrencyCap(): number {
	const raw = Number(
		env.EVENT_TRIGGER_MAX_CONCURRENT ?? process.env.EVENT_TRIGGER_MAX_CONCURRENT ?? 10
	);
	return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 10;
}

/** Count currently-active runs that were started by a trigger. */
export async function countActiveTriggeredRuns(): Promise<number> {
	if (!db) return 0;
	const [row] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(workflowExecutions)
		.where(
			and(
				isNotNull(workflowExecutions.triggerSource),
				inArray(workflowExecutions.status, ACTIVE_STATUSES)
			)
		);
	return row?.n ?? 0;
}

/**
 * Admission decision for one trigger fire. `admit:false` → the handler should
 * DEFER (redeliver). Best-effort: on a count error we admit (fail-open) so the
 * gate can't wedge legitimate triggers — the Kueue queue + Dapr cap still bound
 * the actual resources downstream.
 */
export async function admitTriggeredRun(): Promise<{
	admit: boolean;
	active: number;
	cap: number;
}> {
	const cap = triggerConcurrencyCap();
	try {
		const active = await countActiveTriggeredRuns();
		return { admit: active < cap, active, cap };
	} catch (err) {
		console.warn('[trigger-gate] count failed; admitting (fail-open)', err);
		return { admit: true, active: -1, cap };
	}
}

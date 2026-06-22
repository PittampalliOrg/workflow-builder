import { createHash } from 'node:crypto';

/**
 * Deterministic workflow-execution id for an event-driven trigger, derived from
 * the caller's `dedupKey`. Stable across at-least-once redeliveries so the same
 * event maps to the same `workflow_executions` row (and therefore the same Dapr
 * instance id `sw-<name>-exec-<id>`), making redelivery effectively-once.
 *
 * Kept short so the orchestrator's `sw-<name>-exec-<id>` instance id stays well
 * within Dapr's instance-id length limits.
 */
export function triggerExecutionId(dedupKey: string): string {
	const hex = createHash('sha256').update(dedupKey).digest('hex').slice(0, 24);
	return `evt-${hex}`;
}

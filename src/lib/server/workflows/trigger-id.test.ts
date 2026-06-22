import { describe, expect, it } from 'vitest';
import { triggerExecutionId } from './trigger-id';

describe('triggerExecutionId', () => {
	it('is deterministic for the same dedupKey (idempotency)', () => {
		const a = triggerExecutionId('order-123');
		const b = triggerExecutionId('order-123');
		expect(a).toBe(b);
	});

	it('differs for different dedupKeys', () => {
		expect(triggerExecutionId('order-123')).not.toBe(triggerExecutionId('order-124'));
	});

	it('produces a short, prefixed, instance-id-safe id', () => {
		const id = triggerExecutionId('some-event-key');
		expect(id).toMatch(/^evt-[0-9a-f]{24}$/);
		// Keeps the orchestrator instance id `sw-<name>-exec-<id>` well within limits.
		expect(id.length).toBeLessThanOrEqual(28);
	});
});

import { describe, expect, it, vi } from 'vitest';
import { ApplicationPreviewEnvironmentLifecycleBrokerService } from '$lib/server/application/preview-environment-lifecycle-broker';

const guard = {
	mode: 'owned' as const,
	requestId: 'request-1',
	sourceRevision: 'b'.repeat(40)
};
const ticket = {
	name: 'feature-one',
	environmentUid: 'uid-1',
	requestId: guard.requestId,
	sourceRevision: guard.sourceRevision,
	signature: 'e'.repeat(64)
};

describe('ApplicationPreviewEnvironmentLifecycleBrokerService', () => {
	it('preserves the full-convergence receipt for background callers', async () => {
		let resolveTeardown!: (value: Record<string, unknown>) => void;
		const teardown = vi.fn(
			() =>
				new Promise<Record<string, unknown>>((resolve) => {
					resolveTeardown = resolve;
				})
		);
		const service = new ApplicationPreviewEnvironmentLifecycleBrokerService({
			teardown: teardown as never,
			cleanup: vi.fn(),
			request: vi.fn(),
			status: vi.fn()
		});
		let settled = false;
		const result = service
			.teardown({ name: 'feature-one', guard })
			.finally(() => (settled = true));
		await Promise.resolve();
		expect(settled).toBe(false);

		resolveTeardown({ name: 'feature-one', phase: 'absent' });
		await expect(result).resolves.toEqual({
			preview: { name: 'feature-one', phase: 'absent' },
			receipt: {
				name: 'feature-one',
				guard,
				desiredStateAbsent: true
			}
		});
	});

	it('emits the accepted receipt as soon as deletion submission resolves', async () => {
		const request = vi.fn(async () => ({
			preview: { name: 'feature-one', phase: 'terminating' },
			ticket
		}));
		const service = new ApplicationPreviewEnvironmentLifecycleBrokerService({
			teardown: vi.fn(),
			cleanup: vi.fn(),
			request: request as never,
			status: vi.fn()
		});

			await expect(service.requestTeardown({ name: 'feature-one', guard })).resolves.toEqual({
				preview: { name: 'feature-one', phase: 'terminating' },
				ticket,
				receipt: {
					name: 'feature-one',
					guard,
					ticket,
					desiredStateDeletionAccepted: true
			}
		});
			expect(request).toHaveBeenCalledWith('feature-one', guard);
		});

	it('binds cleanup observations to the accepted ticket', async () => {
		const cleanup = { name: 'feature-one', complete: false, phase: 'pending' };
		const status = vi.fn(async () => cleanup);
		const service = new ApplicationPreviewEnvironmentLifecycleBrokerService({
			teardown: vi.fn(),
			cleanup: vi.fn(),
			request: vi.fn(),
			status: status as never
		});

		await expect(service.status(ticket)).resolves.toEqual({
			cleanup,
			receipt: { ticket }
		});
		expect(status).toHaveBeenCalledWith(ticket);
	});

	it('never emits a receipt when physical teardown fails', async () => {
		const service = new ApplicationPreviewEnvironmentLifecycleBrokerService({
			teardown: vi.fn(async () => {
				throw new Error('finalizer timeout');
			}),
			cleanup: vi.fn(),
			request: vi.fn(),
			status: vi.fn()
		});
		await expect(service.teardown({ name: 'feature-one', guard })).rejects.toThrow(
			'finalizer timeout'
		);
	});
});

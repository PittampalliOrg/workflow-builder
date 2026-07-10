import { describe, expect, it, vi } from 'vitest';
import { ApplicationPreviewEnvironmentLifecycleBrokerService } from '$lib/server/application/preview-environment-lifecycle-broker';

const guard = {
	mode: 'owned' as const,
	requestId: 'request-1',
	sourceRevision: 'b'.repeat(40)
};

describe('ApplicationPreviewEnvironmentLifecycleBrokerService', () => {
	it('emits the exact receipt only after physical teardown resolves', async () => {
		let resolveTeardown!: (value: Record<string, unknown>) => void;
		const teardown = vi.fn(
			() =>
				new Promise<Record<string, unknown>>((resolve) => {
					resolveTeardown = resolve;
				})
		);
		const service = new ApplicationPreviewEnvironmentLifecycleBrokerService({
			teardown: teardown as never,
			cleanup: vi.fn()
		});
		let settled = false;
		const result = service
			.teardown({ name: 'feature-one', guard })
			.finally(() => (settled = true));
		await Promise.resolve();
		expect(settled).toBe(false);

		resolveTeardown({ name: 'feature-one', phase: 'terminating' });
		await expect(result).resolves.toEqual({
			preview: { name: 'feature-one', phase: 'terminating' },
			receipt: {
				name: 'feature-one',
				guard,
				desiredStateAbsent: true
			}
		});
	});

	it('never emits a receipt when physical teardown fails', async () => {
		const service = new ApplicationPreviewEnvironmentLifecycleBrokerService({
			teardown: vi.fn(async () => {
				throw new Error('finalizer timeout');
			}),
			cleanup: vi.fn()
		});
		await expect(service.teardown({ name: 'feature-one', guard })).rejects.toThrow(
			'finalizer timeout'
		);
	});
});


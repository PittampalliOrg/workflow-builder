import { describe, expect, it, vi } from 'vitest';
import { createSessionListRefreshCoordinator } from './session-list-refresh';

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

describe('createSessionListRefreshCoordinator', () => {
	it('does not refresh repeatedly for execution events that retain the same snapshot', async () => {
		const request = deferred<void>();
		const load = vi.fn(() => request.promise);
		const coordinator = createSessionListRefreshCoordinator(load);
		const snapshot = {};

		const first = coordinator.refreshForSnapshot(snapshot);
		for (let event = 0; event < 100; event += 1) {
			expect(coordinator.refreshForSnapshot(snapshot)).toBeNull();
		}

		await Promise.resolve();
		expect(load).toHaveBeenCalledOnce();

		request.resolve();
		await first;

		await coordinator.refreshForSnapshot({});
		expect(load).toHaveBeenCalledTimes(2);
	});

	it('shares one in-flight request across polling and snapshot refresh signals', async () => {
		const request = deferred<void>();
		const load = vi
			.fn<() => Promise<void>>()
			.mockReturnValueOnce(request.promise)
			.mockResolvedValue(undefined);
		const coordinator = createSessionListRefreshCoordinator(load);

		const pollRefresh = coordinator.refresh();
		const repeatedPollRefresh = coordinator.refresh();
		const snapshotRefresh = coordinator.refreshForSnapshot({});

		expect(repeatedPollRefresh).toBe(pollRefresh);
		expect(snapshotRefresh).toBe(pollRefresh);
		await Promise.resolve();
		expect(load).toHaveBeenCalledOnce();

		request.resolve();
		await Promise.all([pollRefresh, repeatedPollRefresh, snapshotRefresh]);

		await coordinator.refresh();
		expect(load).toHaveBeenCalledTimes(2);
	});

	it('ignores missing snapshots', () => {
		const load = vi.fn(async () => undefined);
		const coordinator = createSessionListRefreshCoordinator(load);

		expect(coordinator.refreshForSnapshot(null)).toBeNull();
		expect(load).not.toHaveBeenCalled();
	});
});

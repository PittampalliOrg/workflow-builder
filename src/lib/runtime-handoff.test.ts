import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	runtimeHandoffChanged,
	startRuntimeHandoffWatcher
} from '$lib/runtime-handoff';
import type { RuntimeHandoffIdentity } from '$lib/types/runtime-handoff';

const deployed: RuntimeHandoffIdentity = {
	watch: true,
	previewName: 'ui-proof',
	mode: 'deployed',
	generation: 'ui-proof:deployed'
};

afterEach(() => {
	vi.useRealTimers();
});

describe('runtime handoff watcher', () => {
	it('recognizes only a mode change for the same preview origin', () => {
		expect(
			runtimeHandoffChanged(deployed, {
				...deployed,
				mode: 'live-sync',
				generation: 'ui-proof:live-sync'
			})
		).toBe(true);
		expect(runtimeHandoffChanged(deployed, { ...deployed, previewName: 'other' })).toBe(false);
		expect(runtimeHandoffChanged({ ...deployed, watch: false }, deployed)).toBe(false);
	});

	it('reloads once when the preview Service starts answering from Vite', async () => {
		vi.useFakeTimers();
		const reload = vi.fn();
		const fetch = vi.fn(async () =>
			new Response(
				JSON.stringify({
					...deployed,
					mode: 'live-sync',
					generation: 'ui-proof:live-sync'
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			)
		);

		const stop = startRuntimeHandoffWatcher({ baseline: deployed, fetch, reload, intervalMs: 25 });
		await vi.advanceTimersByTimeAsync(25);
		expect(fetch).toHaveBeenCalledWith('/api/runtime-handoff', {
			cache: 'no-store',
			headers: { 'cache-control': 'no-cache' }
		});
		expect(reload).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(100);
		expect(fetch).toHaveBeenCalledOnce();
		stop();
	});

	it('does not poll outside a preview deployment', async () => {
		vi.useFakeTimers();
		const fetch = vi.fn();
		const stop = startRuntimeHandoffWatcher({
			baseline: { ...deployed, watch: false },
			fetch: fetch as unknown as typeof globalThis.fetch,
			reload: vi.fn(),
			intervalMs: 10
		});
		await vi.advanceTimersByTimeAsync(100);
		expect(fetch).not.toHaveBeenCalled();
		stop();
	});
});

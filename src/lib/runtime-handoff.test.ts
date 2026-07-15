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

function visibilityTarget(initiallyHidden = false) {
	let listener: (() => void) | undefined;
	return {
		target: {
			hidden: initiallyHidden,
			addEventListener: vi.fn((_event: string, next: EventListenerOrEventListenerObject) => {
				listener = next as () => void;
			}),
			removeEventListener: vi.fn()
		},
		setHidden(hidden: boolean) {
			this.target.hidden = hidden;
			listener?.();
		}
	};
}

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

	it('cannot reload or reschedule after stopping an in-flight probe', async () => {
		vi.useFakeTimers();
		let resolveFetch!: (response: Response) => void;
		const fetch = vi.fn(
			() => new Promise<Response>((resolve) => {
				resolveFetch = resolve;
			})
		);
		const reload = vi.fn();
		const stop = startRuntimeHandoffWatcher({ baseline: deployed, fetch, reload, intervalMs: 10 });

		await vi.advanceTimersByTimeAsync(10);
		expect(fetch).toHaveBeenCalledOnce();
		stop();
		resolveFetch(
			new Response(
				JSON.stringify({
					...deployed,
					mode: 'live-sync',
					generation: 'ui-proof:live-sync'
				}),
				{ status: 200 }
			)
		);
		await vi.runAllTimersAsync();

		expect(reload).not.toHaveBeenCalled();
		expect(fetch).toHaveBeenCalledOnce();
	});

	it('pauses in a hidden tab and probes immediately when it becomes visible', async () => {
		vi.useFakeTimers();
		const visibility = visibilityTarget(true);
		const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
		const stop = startRuntimeHandoffWatcher({
			baseline: deployed,
			fetch,
			reload: vi.fn(),
			intervalMs: 25,
			visibility: visibility.target
		});

		await vi.advanceTimersByTimeAsync(100);
		expect(fetch).not.toHaveBeenCalled();
		visibility.setHidden(false);
		await vi.advanceTimersByTimeAsync(0);
		expect(fetch).toHaveBeenCalledOnce();
		visibility.setHidden(true);
		await vi.advanceTimersByTimeAsync(100);
		expect(fetch).toHaveBeenCalledOnce();
		stop();
	});
});

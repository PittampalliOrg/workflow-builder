/**
 * Generic factory for a KueueViz SSE store. Consumers get back a
 * runes-shaped object exposing:
 *   - `data`: the most recent projected snapshot (typed)
 *   - `status`: connection state (`connecting | open | degraded | closed`)
 *   - `error`: last error message, if any
 *   - `lastUpdate`: ISO timestamp of the last snapshot
 *
 * Mirrors the pattern in `lib/stores/sandbox-stream.svelte.ts` but adds
 * the `status` side-band that the BFF emits per upstream connection
 * lifecycle event.
 *
 * IMPORTANT: this file uses Svelte 5 runes. It must only be imported
 * from `.svelte` / `.svelte.ts` modules running on the client.
 */

import type { StatusEvent, StreamStatus } from '$lib/server/kueueviz';

export type KueueVizStream<T> = {
	readonly data: T;
	readonly status: StreamStatus;
	readonly error: string | null;
	readonly lastUpdate: string | null;
	readonly connected: boolean;
};

export type CreateStreamOptions<T> = {
	endpoint: string;
	params?: Record<string, string>;
	initial: T;
	parse?: (raw: unknown) => T;
};

export function createKueueVizStream<T>(
	options: CreateStreamOptions<T>,
): KueueVizStream<T> {
	const parse = options.parse ?? ((raw) => raw as T);

	// $state.raw — snapshots are always reassigned wholesale, never mutated.
	let data = $state.raw<T>(options.initial);
	let status = $state<StreamStatus>('connecting');
	let error = $state<string | null>(null);
	let lastUpdate = $state<string | null>(null);

	$effect(() => {
		const search = new URLSearchParams();
		for (const [k, v] of Object.entries(options.params ?? {})) {
			if (v) search.set(k, v);
		}
		const qs = search.toString();
		const url = `/api/kueueviz/${options.endpoint}${qs ? `?${qs}` : ''}`;
		const es = new EventSource(url);

		es.addEventListener('snapshot', (event) => {
			try {
				const parsed = JSON.parse((event as MessageEvent).data);
				data = parse(parsed);
				lastUpdate = new Date().toISOString();
				if (status !== 'open') status = 'open';
				error = null;
			} catch (err) {
				error = err instanceof Error ? err.message : 'malformed snapshot';
			}
		});

		es.addEventListener('status', (event) => {
			try {
				const parsed = JSON.parse((event as MessageEvent).data) as StatusEvent;
				status = parsed.state;
				error = parsed.error ?? null;
			} catch {
				// ignore — status event must be a `StatusEvent` JSON; if not we
				// keep the prior state.
			}
		});

		es.addEventListener('heartbeat', () => {
			// Browsers normally translate transport-level idle to readyState
			// changes; the heartbeat is here so flakey proxies don't kill
			// the connection. Nothing else to do.
		});

		es.onerror = () => {
			status = 'degraded';
			error = error ?? 'connection lost — retrying';
		};

		return () => {
			// Just close the upstream EventSource — never mutate `status` here.
			// Cleanup runs during `$derived` freezing when a parent swaps a
			// store reference (e.g. tab change). Mutating `$state` in that
			// phase trips Svelte 5's `state_unsafe_mutation` guard. The store
			// instance is being discarded anyway, so its `status` no longer
			// matters; consumers will read from the new store.
			es.close();
		};
	});

	return {
		get data() {
			return data;
		},
		get status() {
			return status;
		},
		get error() {
			return error;
		},
		get lastUpdate() {
			return lastUpdate;
		},
		get connected() {
			return status === 'open';
		},
	};
}

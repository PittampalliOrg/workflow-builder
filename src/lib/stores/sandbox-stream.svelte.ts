/**
 * Svelte 5 runes-based reactive store for consuming sandbox list SSE stream.
 *
 * This store provides real-time updates via SSE. For initial data loading,
 * use the remote function (getSandboxes) instead.
 *
 * Best practices applied:
 *   - $state.raw for API response arrays (reassigned, not mutated — avoids proxy overhead)
 *   - $effect cleanup returns close the EventSource
 *   - No derived state computed inside effects
 */

import type { Sandbox } from '$lib/types/sandbox';

export function createSandboxListStream() {
	// $state.raw: sandbox arrays are always reassigned from SSE snapshots, never mutated in place.
	// Using .raw avoids deep-proxy overhead on potentially large arrays of objects.
	let sandboxes = $state.raw<Sandbox[]>([]);
	let isConnected = $state(false);
	let isStreaming = $state(false);
	let error = $state<string | null>(null);

	$effect(() => {
		const es = new EventSource('/api/sandboxes/stream');

		es.onopen = () => {
			isConnected = true;
			error = null;
		};

		es.onerror = () => {
			isConnected = false;
			isStreaming = false;
			error = 'Connection lost';
		};

		es.addEventListener('snapshot', (e) => {
			try {
				const data = JSON.parse((e as MessageEvent).data);
				sandboxes = data.sandboxes ?? [];
				isStreaming = true;
			} catch {
				// ignore unparseable
			}
		});

		es.addEventListener('sandbox_changed', (e) => {
			try {
				const updated = JSON.parse((e as MessageEvent).data) as Sandbox;
				sandboxes = sandboxes.map((s) =>
					s.name === updated.name ? { ...s, ...updated } : s
				);
			} catch {
				// ignore
			}
		});

		es.addEventListener('sandbox_added', (e) => {
			try {
				const added = JSON.parse((e as MessageEvent).data) as Sandbox;
				if (!sandboxes.some((s) => s.name === added.name)) {
					sandboxes = [...sandboxes, added];
				}
			} catch {
				// ignore
			}
		});

		es.addEventListener('sandbox_removed', (e) => {
			try {
				const removed = JSON.parse((e as MessageEvent).data);
				sandboxes = sandboxes.filter((s) => s.name !== removed.name);
			} catch {
				// ignore
			}
		});

		es.addEventListener('heartbeat', () => {
			isConnected = true;
		});

		return () => {
			es.close();
			isConnected = false;
			isStreaming = false;
		};
	});

	return {
		get sandboxes() {
			return sandboxes;
		},
		get isConnected() {
			return isConnected;
		},
		get isStreaming() {
			return isStreaming;
		},
		get error() {
			return error;
		}
	};
}

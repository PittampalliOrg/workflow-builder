/**
 * Svelte 5 runes-based reactive store for consuming sandbox detail SSE stream.
 *
 * Best practices:
 *   - $state.raw for log/event arrays (reassigned, not mutated)
 *   - $effect cleanup closes EventSource
 *   - isStreaming distinguishes "SSE active" from "no data yet"
 */

import type { Sandbox, SandboxLogEntry, SandboxEvent } from '$lib/types/sandbox';

const MAX_LOGS = 500;
const MAX_EVENTS = 200;

export function createSandboxDetailStream(name: string) {
	let status = $state<Sandbox | null>(null);
	let logs = $state.raw<SandboxLogEntry[]>([]);
	let events = $state.raw<SandboxEvent[]>([]);
	let isConnected = $state(false);
	let isStreaming = $state(false);
	let isTerminal = $state(false);
	let notFound = $state(false);
	let error = $state<string | null>(null);

	function pushLog(entry: SandboxLogEntry) {
		logs = [...logs.slice(-(MAX_LOGS - 1)), entry];
	}

	function pushEvent(entry: SandboxEvent) {
		events = [...events.slice(-(MAX_EVENTS - 1)), entry];
	}

	$effect(() => {
		if (!name) return;

		const es = new EventSource(`/api/sandboxes/${encodeURIComponent(name)}/stream`);

		es.onopen = () => {
			isConnected = true;
			error = null;
		};

		es.onerror = () => {
			isConnected = false;
			if (!isStreaming) {
				error = 'Connection lost';
			}
		};

		es.addEventListener('status', (e) => {
			try {
				const data = JSON.parse((e as MessageEvent).data);
				status = {
					name: data.name ?? name,
					type: data.type ?? 'openshell',
					phase: (data.phase?.toUpperCase() ?? 'UNKNOWN') as Sandbox['phase'],
					image: data.image,
					provider: data.provider,
					createdAt: data.createdAt ?? data.created,
					conditions: data.conditions
				};
				isStreaming = true;
				notFound = false;
			} catch {
				// ignore
			}
		});

		es.addEventListener('log', (e) => {
			try {
				const data = JSON.parse((e as MessageEvent).data);
				pushLog({
					level: data.level ?? 'INFO',
					source: data.source ?? '',
					message: data.message ?? '',
					timestamp: data.timestamp ?? new Date().toISOString(),
					eventType: data.eventType,
					fields: data.fields
				});
			} catch {
				// ignore
			}
		});

		es.addEventListener('k8s_event', (e) => {
			try {
				const data = JSON.parse((e as MessageEvent).data);
				pushEvent({
					reason: data.reason ?? '',
					message: data.message ?? '',
					source: data.source ?? '',
					timestamp: data.timestamp ?? new Date().toISOString(),
					type: data.type,
					metadata: data.metadata
				});
			} catch {
				// ignore
			}
		});

		es.addEventListener('warning', (e) => {
			try {
				const data = JSON.parse((e as MessageEvent).data);
				pushLog({
					level: 'WARN',
					source: 'gateway',
					message: data.message ?? '',
					timestamp: data.timestamp ?? new Date().toISOString()
				});
			} catch {
				// ignore
			}
		});

		es.addEventListener('not_found', () => {
			notFound = true;
			isStreaming = true;
		});

		es.addEventListener('terminal', () => {
			isTerminal = true;
			es.close();
			isConnected = false;
		});

		es.addEventListener('heartbeat', () => {
			isConnected = true;
			isStreaming = true;
		});

		return () => {
			es.close();
			isConnected = false;
		};
	});

	return {
		get status() {
			return status;
		},
		get logs() {
			return logs;
		},
		get events() {
			return events;
		},
		get isConnected() {
			return isConnected;
		},
		get isStreaming() {
			return isStreaming;
		},
		get isTerminal() {
			return isTerminal;
		},
		get notFound() {
			return notFound;
		},
		get error() {
			return error;
		}
	};
}

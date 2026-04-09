import type { RequestHandler } from './$types';
import { openshellRuntimeFetch } from '$lib/server/openshell-runtime';
import { normalizeSandboxResponse } from '$lib/utils/sandbox-parse';
import { sandboxEventBus, type SandboxBusEvent } from '$lib/server/sandbox-event-bus';
import { listSandboxAgentEvents } from '$lib/server/execution-read-model';
import type { Sandbox } from '$lib/types/sandbox';

const STATUS_POLL_INTERVAL_MS = 3000;
const EVENTS_POLL_INTERVAL_MS = 2000;

const encoder = new TextEncoder();

interface AgentEvent {
	id: number;
	type: string;
	data: Record<string, unknown>;
	timestamp: string;
}

function serializeSse(event: string, data: unknown): Uint8Array {
	return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function formatAgentEventMessage(event: AgentEvent): string {
	const data = event.data ?? {};
	switch (event.type) {
		case 'tool_call_start':
			return `Tool: ${data.toolName ?? data.name ?? 'unknown'} started`;
		case 'tool_call_end':
			return `Tool: ${data.toolName ?? data.name ?? 'unknown'} completed`;
		case 'tool_call_error':
			return `Tool error: ${data.error ?? data.message ?? 'unknown'}`;
		case 'sandbox_output':
		case 'sandbox_output_partial':
			return String(data.output ?? data.text ?? data.message ?? '');
		case 'sandbox_heartbeat':
			return 'Sandbox heartbeat';
		case 'llm_start':
			return 'LLM inference started';
		case 'llm_complete':
			return 'LLM inference completed';
		case 'run_started':
			return 'Agent run started';
		case 'run_complete':
			return 'Agent run completed';
		case 'run_error':
			return `Agent run error: ${data.error ?? 'unknown'}`;
		case 'turn_started':
			return `Turn ${data.turnNumber ?? ''} started`;
		default:
			return data.message ? String(data.message) : event.type;
	}
}

async function fetchSandboxByName(name: string): Promise<Sandbox | null> {
	const fromBus = sandboxEventBus.get(name);
	if (fromBus) return fromBus;

	try {
		const detailRes = await openshellRuntimeFetch(
			`/api/v1/sandboxes/${encodeURIComponent(name)}`
		);
		if (detailRes.ok) {
			const data = await detailRes.json();
			if (data.ok !== false && data.name) {
				return {
					name: data.name,
					type: (data.type as Sandbox['type']) ?? 'openshell',
					phase: (data.phase?.toUpperCase() ?? 'UNKNOWN') as Sandbox['phase'],
					image: data.image,
					createdAt: data.created ?? data.createdAt
				};
			}
		}
	} catch {
		// fall through
	}

	const listRes = await openshellRuntimeFetch('/api/v1/sandboxes');
	if (!listRes.ok) return null;
	const data = await listRes.json();
	const sandboxes = normalizeSandboxResponse(data);
	return sandboxes.find((s) => s.name === name) ?? null;
}

export const GET: RequestHandler = async ({ params, request }) => {
	const name = params.name;

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			let statusTimer: ReturnType<typeof setTimeout> | null = null;
			let eventsTimer: ReturnType<typeof setTimeout> | null = null;
			let unsubscribe: (() => void) | null = null;
			let lastStatusJson = '';
			let lastAgentEventId = 0;

			const close = () => {
				if (closed) return;
				closed = true;
				unsubscribe?.();
				if (statusTimer) clearTimeout(statusTimer);
				if (eventsTimer) clearTimeout(eventsTimer);
				try {
					controller.close();
				} catch {
					// ignore
				}
			};

			request.signal.addEventListener('abort', close, { once: true });

			// --- Status stream (sandbox phase) ---
			const pollStatus = async () => {
				if (closed) return;

				// Check event bus first
				if (sandboxEventBus.isSeeded && !unsubscribe) {
					const sb = sandboxEventBus.get(name);
					if (sb) {
						const json = JSON.stringify(sb);
						if (json !== lastStatusJson) {
							controller.enqueue(serializeSse('status', sb));
							lastStatusJson = json;
						}
					}
					unsubscribe = sandboxEventBus.subscribe((event: SandboxBusEvent) => {
						if (closed) return;
						try {
							if (event.sandbox?.name === name && (event.type === 'sandbox_changed' || event.type === 'sandbox_added')) {
								controller.enqueue(serializeSse('status', event.sandbox));
							} else if (event.type === 'sandbox_removed' && event.name === name) {
								controller.enqueue(serializeSse('not_found', { name, timestamp: new Date().toISOString() }));
							}
						} catch {
							close();
						}
					});
					return; // Event bus takes over for status
				}

				try {
					const sandbox = await fetchSandboxByName(name);
					if (!sandbox) {
						controller.enqueue(serializeSse('not_found', { name, timestamp: new Date().toISOString() }));
					} else {
						const json = JSON.stringify(sandbox);
						if (json !== lastStatusJson) {
							controller.enqueue(serializeSse('status', sandbox));
							lastStatusJson = json;
						}
					}
					controller.enqueue(serializeSse('heartbeat', { ts: Date.now() }));
				} catch {
					// skip cycle
				}

				if (!closed) {
					statusTimer = setTimeout(pollStatus, STATUS_POLL_INTERVAL_MS);
				}
			};

			// --- Agent events stream (workflow execution logs) ---
			const pollAgentEvents = async () => {
				if (closed) return;
				try {
					const events = await listSandboxAgentEvents(name, lastAgentEventId);
					for (const event of events) {
						if (closed) break;
						lastAgentEventId = Math.max(lastAgentEventId, event.id);
						controller.enqueue(
							serializeSse('log', {
								level: event.type.includes('error') ? 'ERROR' : 'INFO',
								source: (event.data?.toolName as string) ?? event.type,
								message: formatAgentEventMessage(event),
								timestamp: event.timestamp,
								eventType: event.type,
								data: event.data
							})
						);
					}
				} catch {
					// DB query failed — skip cycle
				}
				if (!closed) {
					eventsTimer = setTimeout(pollAgentEvents, EVENTS_POLL_INTERVAL_MS);
				}
			};

			// Start both polling loops
			void pollStatus();
			void pollAgentEvents();
		},
		cancel() {
			// no-op, abort listener handles cleanup
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no'
		}
	});
};

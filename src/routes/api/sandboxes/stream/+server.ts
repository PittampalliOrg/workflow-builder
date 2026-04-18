import type { RequestHandler } from './$types';
import { openshellRuntimeFetch } from '$lib/server/openshell-runtime';
import { normalizeSandboxResponse } from '$lib/utils/sandbox-parse';
import { sandboxEventBus, type SandboxBusEvent } from '$lib/server/sandbox-event-bus';
import { listAgentRuntimeSandboxes } from '$lib/server/agent-runtime-sandboxes';
import { attachSandboxSessions } from '$lib/server/sandbox-sessions';
import type { Sandbox } from '$lib/types/sandbox';

const POLL_INTERVAL_MS = 2000;
const encoder = new TextEncoder();

function serializeSse(event: string, data: unknown): Uint8Array {
	return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sandboxChanged(a: Sandbox, b: Sandbox): boolean {
	return JSON.stringify(a) !== JSON.stringify(b);
}

async function mergeRuntimeSandboxes(sandboxes: Sandbox[]): Promise<Sandbox[]> {
	const runtimeSandboxes = await listAgentRuntimeSandboxes();
	const byName = new Map(sandboxes.map((sandbox) => [sandbox.name, sandbox]));
	for (const sandbox of runtimeSandboxes) {
		byName.set(sandbox.name, sandbox);
	}
	return attachSandboxSessions(Array.from(byName.values()));
}

async function fetchSandboxes(): Promise<Sandbox[]> {
	const [openshellResult, runtimeResult] = await Promise.allSettled([
		openshellRuntimeFetch('/api/v1/sandboxes'),
		listAgentRuntimeSandboxes()
	]);
	const openshellSandboxes =
		openshellResult.status === 'fulfilled' && openshellResult.value.ok
			? normalizeSandboxResponse(await openshellResult.value.json())
			: [];
	const runtimeSandboxes = runtimeResult.status === 'fulfilled' ? runtimeResult.value : [];
	if (openshellResult.status === 'fulfilled' && !openshellResult.value.ok && runtimeResult.status !== 'fulfilled') {
		throw new Error(`OpenShell sandboxes fetch failed (${openshellResult.value.status})`);
	}
	// Stamp the owning session so the list page's Session column is populated
	// on both the initial SSE snapshot and every poll-driven refresh.
	return attachSandboxSessions([...openshellSandboxes, ...runtimeSandboxes]);
}

export const GET: RequestHandler = async ({ request }) => {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			let unsubscribe: (() => void) | null = null;
			let pollTimer: ReturnType<typeof setTimeout> | null = null;
			let lastSandboxes = new Map<string, Sandbox>();

			const close = () => {
				if (closed) return;
				closed = true;
				unsubscribe?.();
				if (pollTimer) clearTimeout(pollTimer);
				try {
					controller.close();
				} catch {
					// ignore close races
				}
			};

			request.signal.addEventListener('abort', close, { once: true });

			// If the event bus has data, use it as the primary source
			if (sandboxEventBus.isSeeded) {
				const sandboxes = sandboxEventBus.getAll();
				lastSandboxes = new Map(sandboxes.map((s) => [s.name, s]));
				void mergeRuntimeSandboxes(sandboxes)
					.then((merged) => {
						if (closed) return;
						lastSandboxes = new Map(merged.map((s) => [s.name, s]));
						controller.enqueue(serializeSse('snapshot', { sandboxes: merged }));
					})
					.catch(() => controller.enqueue(serializeSse('snapshot', { sandboxes })));

				// Subscribe to event bus for push-based updates
				unsubscribe = sandboxEventBus.subscribe((event: SandboxBusEvent) => {
					if (closed) return;
					try {
						switch (event.type) {
							case 'snapshot':
								void mergeRuntimeSandboxes(event.sandboxes ?? [])
									.then((merged) => {
										if (!closed) controller.enqueue(serializeSse('snapshot', { sandboxes: merged }));
									})
									.catch(() => controller.enqueue(serializeSse('snapshot', { sandboxes: event.sandboxes ?? [] })));
								break;
							case 'sandbox_added':
								if (event.sandbox) {
									controller.enqueue(serializeSse('sandbox_added', event.sandbox));
								}
								break;
							case 'sandbox_changed':
								if (event.sandbox) {
									controller.enqueue(serializeSse('sandbox_changed', event.sandbox));
								}
								break;
							case 'sandbox_removed':
								controller.enqueue(
									serializeSse('sandbox_removed', { name: event.name })
								);
								break;
						}
					} catch {
						close();
					}
				});
			} else {
				// Event bus not seeded yet — fall back to polling until it is
				const schedulePoll = () => {
					if (closed) return;
					pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
				};

				const poll = async () => {
					if (closed) return;

					// Check if event bus got seeded while we were polling
					if (sandboxEventBus.isSeeded && !unsubscribe) {
						const sandboxes = sandboxEventBus.getAll();
						void mergeRuntimeSandboxes(sandboxes)
							.then((merged) => {
								if (!closed) controller.enqueue(serializeSse('snapshot', { sandboxes: merged }));
							})
							.catch(() => controller.enqueue(serializeSse('snapshot', { sandboxes })));
						unsubscribe = sandboxEventBus.subscribe((event: SandboxBusEvent) => {
							if (closed) return;
							try {
								switch (event.type) {
									case 'snapshot':
										void mergeRuntimeSandboxes(event.sandboxes ?? [])
											.then((merged) => {
												if (!closed) controller.enqueue(serializeSse('snapshot', { sandboxes: merged }));
											})
											.catch(() => controller.enqueue(serializeSse('snapshot', { sandboxes: event.sandboxes ?? [] })));
										break;
									case 'sandbox_added':
										if (event.sandbox) {
											controller.enqueue(
												serializeSse('sandbox_added', event.sandbox)
											);
										}
										break;
									case 'sandbox_changed':
										if (event.sandbox) {
											controller.enqueue(
												serializeSse('sandbox_changed', event.sandbox)
											);
										}
										break;
									case 'sandbox_removed':
										controller.enqueue(
											serializeSse('sandbox_removed', { name: event.name })
										);
										break;
								}
							} catch {
								close();
							}
						});
						return; // Stop polling, event bus takes over
					}

					try {
						const sandboxes = await fetchSandboxes();
						const current = new Map(
							sandboxes.map((sandbox) => [sandbox.name, sandbox])
						);

						if (lastSandboxes.size === 0) {
							controller.enqueue(serializeSse('snapshot', { sandboxes }));
						} else {
							for (const sandbox of sandboxes) {
								const previous = lastSandboxes.get(sandbox.name);
								if (!previous) {
									controller.enqueue(serializeSse('sandbox_added', sandbox));
								} else if (sandboxChanged(previous, sandbox)) {
									controller.enqueue(serializeSse('sandbox_changed', sandbox));
								}
							}
							for (const [name] of lastSandboxes) {
								if (!current.has(name)) {
									controller.enqueue(
										serializeSse('sandbox_removed', { name })
									);
								}
							}
						}

						lastSandboxes = current;
						controller.enqueue(serializeSse('heartbeat', { ts: Date.now() }));
					} catch (error) {
						controller.enqueue(
							serializeSse('error', {
								message:
									error instanceof Error
										? error.message
										: 'Sandbox stream poll failed'
							})
						);
					} finally {
						schedulePoll();
					}
				};

				void poll();
			}
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

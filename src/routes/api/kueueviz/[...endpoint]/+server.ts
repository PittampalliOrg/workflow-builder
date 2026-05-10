/**
 * SSE dispatcher for KueueViz upstream subscriptions.
 *
 * Path → endpoint mapping (verbatim):
 *   /api/kueueviz/cluster-queues
 *   /api/kueueviz/workloads          (?namespace=<...>)
 *   /api/kueueviz/resource-flavors
 *   /api/kueueviz/local-queues
 *   /api/kueueviz/cohorts
 *
 * Anything else → 404. The path tail is matched against the typed
 * allowlist in `endpoints.ts`; query params are filtered to the per-
 * endpoint schema before keying the pool.
 */

import { error } from '@sveltejs/kit';
import { isEndpointKey, kueuevizPool, type EndpointKey } from '$lib/server/kueueviz';
import type { StatusEvent } from '$lib/server/kueueviz';
import type { RequestHandler } from './$types';

const encoder = new TextEncoder();
const HEARTBEAT_MS = 15_000;

function sseEvent(event: string, data: unknown): Uint8Array {
	return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function paramsFromUrl(url: URL): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of url.searchParams.entries()) {
		if (typeof v === 'string') out[k] = v;
	}
	return out;
}

export const GET: RequestHandler = async ({ params, request, url, locals }) => {
	if (!locals.session?.userId) {
		throw error(401, 'Authentication required');
	}

	const tail = (params.endpoint ?? '').split('/').filter(Boolean);

	// Map `/api/kueueviz/<...>` into our endpoint keys + path params.
	//   workload/<ns>/<name>          → key: 'workload',         params: {namespace, name}
	//   workload/<ns>/<name>/events   → key: 'workload-events',  params: {namespace, name}
	//   <single>                      → key matches allowlist directly
	let endpoint: EndpointKey;
	const pathParams: Record<string, string> = {};
	if (tail.length === 1 && isEndpointKey(tail[0])) {
		endpoint = tail[0];
	} else if (tail.length === 3 && tail[0] === 'workload') {
		endpoint = 'workload';
		pathParams.namespace = tail[1];
		pathParams.name = tail[2];
	} else if (tail.length === 4 && tail[0] === 'workload' && tail[3] === 'events') {
		endpoint = 'workload-events';
		pathParams.namespace = tail[1];
		pathParams.name = tail[2];
	} else {
		throw error(404, 'unknown kueueviz endpoint');
	}

	const queryParams = { ...paramsFromUrl(url), ...pathParams };

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			let unsubscribe: (() => void) | null = null;
			let heartbeat: ReturnType<typeof setInterval> | null = null;

			const push = (chunk: Uint8Array): void => {
				if (closed) return;
				try {
					controller.enqueue(chunk);
				} catch {
					close();
				}
			};

			const close = (): void => {
				if (closed) return;
				closed = true;
				try {
					unsubscribe?.();
				} catch {
					/* ignore */
				}
				if (heartbeat) clearInterval(heartbeat);
				try {
					controller.close();
				} catch {
					/* ignore */
				}
			};

			request.signal.addEventListener('abort', close, { once: true });

			unsubscribe = kueuevizPool.subscribe(endpoint, queryParams, {
				onSnapshot: (data) => push(sseEvent('snapshot', data)),
				onStatus: (event: StatusEvent) => push(sseEvent('status', event)),
			});

			heartbeat = setInterval(() => {
				push(sseEvent('heartbeat', { ts: Date.now() }));
			}, HEARTBEAT_MS);
		},
		cancel() {
			// abort listener handles cleanup
		},
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			// Some ingress proxies buffer streamed responses; this header
			// hints to nginx-style proxies to flush as bytes arrive.
			'X-Accel-Buffering': 'no',
		},
	});
};

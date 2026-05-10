/**
 * SubscriberPool — singleton fan-out from one upstream KueueViz WS per
 * (endpoint, query) to many SSE consumers.
 *
 * Why fan-out: KueueViz backend is single-replica and `/ws/workloads/dashboard`
 * does an N+1 pod list per workload on every churn. Per-client subscriptions
 * would multiply that cost; pooling caps it at one watcher per topic.
 *
 * Lifecycle per UpstreamStream:
 *   - First subscriber dials upstream and caches the latest snapshot.
 *   - Subsequent subscribers receive cached snapshot synchronously, then live.
 *   - Last subscriber → 30s grace (±20% jitter) → close upstream.
 *   - Reconnect: exponential backoff 1s → 30s with jitter on close/error.
 *   - Status changes (`connecting | open | degraded | closed`) broadcast to
 *     all subscribers as a side-band event so the UI can render a pill.
 *
 * HMR-safe: lives on `globalThis.__kueueviz_pool` and disposes upstream
 * sockets when Vite hot-reloads the module under devspace.
 */

import WebSocket from 'ws';
import { dialKueueViz, payloadToString, WS_SUBPROTOCOL } from './client';
import {
	ENDPOINTS,
	poolCacheKey,
	resolveUpstreamPath,
	type EndpointKey,
} from './endpoints';
import { projectByEndpoint } from './projections';
import type { StatusEvent, StreamStatus } from './types';

export type Subscriber = {
	onSnapshot: (data: unknown) => void;
	onStatus: (event: StatusEvent) => void;
};

const IDLE_GRACE_MS = 30_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const HANDSHAKE_OPEN_TIMEOUT_MS = 12_000;
const SNAPSHOT_QUEUE_LIMIT = 4;

function jittered(value: number, ratio = 0.2): number {
	const delta = value * ratio;
	return value + (Math.random() * 2 - 1) * delta;
}

class UpstreamStream {
	readonly key: string;
	private endpoint: EndpointKey;
	private params: Record<string, string>;
	private ws: WebSocket | null = null;
	private subscribers = new Set<Subscriber>();
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectAttempt = 0;
	private status: StreamStatus = 'closed';
	private cachedSnapshot: unknown = null;
	private lastError: string | null = null;
	private opened = false;
	/** Disposed pools must not reconnect or accept new subscribers. */
	private disposed = false;

	constructor(key: string, endpoint: EndpointKey, params: Record<string, string>) {
		this.key = key;
		this.endpoint = endpoint;
		this.params = params;
	}

	get subscriberCount(): number {
		return this.subscribers.size;
	}

	get currentStatus(): StreamStatus {
		return this.status;
	}

	subscribe(subscriber: Subscriber): () => void {
		if (this.disposed) {
			subscriber.onStatus({ state: 'closed', error: 'pool disposed', at: nowIso() });
			return () => {};
		}
		this.subscribers.add(subscriber);

		// Cancel idle close — we have a live consumer again.
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}

		// Synchronous prime: send cached snapshot + current status to the new
		// subscriber so it doesn't have to wait for the next upstream tick.
		subscriber.onStatus({
			state: this.status,
			error: this.lastError ?? undefined,
			at: nowIso(),
		});
		if (this.cachedSnapshot !== null) {
			try {
				subscriber.onSnapshot(this.cachedSnapshot);
			} catch {
				// subscriber error — don't propagate
			}
		}

		// First subscriber → dial upstream.
		if (this.ws === null && !this.reconnectTimer) {
			this.openUpstream();
		}

		return () => this.unsubscribe(subscriber);
	}

	private unsubscribe(subscriber: Subscriber): void {
		this.subscribers.delete(subscriber);
		if (this.subscribers.size === 0) {
			this.scheduleIdleClose();
		}
	}

	private scheduleIdleClose(): void {
		if (this.idleTimer || this.disposed) return;
		this.idleTimer = setTimeout(() => {
			this.idleTimer = null;
			if (this.subscribers.size === 0) this.closeUpstream('idle');
		}, jittered(IDLE_GRACE_MS));
	}

	private openUpstream(): void {
		if (this.disposed) return;

		this.broadcastStatus('connecting');
		let openTimeout: ReturnType<typeof setTimeout> | null = null;

		try {
			const path = resolveUpstreamPath(this.endpoint, this.params);
			const desc = ENDPOINTS[this.endpoint];
			const queryOnly: Record<string, string> = {};
			for (const k of desc.query) {
				const v = this.params[k];
				if (v) queryOnly[k] = v;
			}
			const ws = dialKueueViz({ path, query: queryOnly });
			this.ws = ws;
			this.opened = false;

			openTimeout = setTimeout(() => {
				if (!this.opened) {
					this.lastError = `handshake timeout after ${HANDSHAKE_OPEN_TIMEOUT_MS}ms`;
					try {
						ws.terminate();
					} catch {
						/* ignore */
					}
				}
			}, HANDSHAKE_OPEN_TIMEOUT_MS);

			ws.on('open', () => {
				this.opened = true;
				if (openTimeout) {
					clearTimeout(openTimeout);
					openTimeout = null;
				}
				const negotiated = ws.protocol;
				if (negotiated && negotiated !== WS_SUBPROTOCOL) {
					this.lastError = `unexpected upstream subprotocol "${negotiated}"`;
					try {
						ws.close(1002, 'subprotocol mismatch');
					} catch {
						/* ignore */
					}
					return;
				}
				this.lastError = null;
				this.reconnectAttempt = 0;
				this.broadcastStatus('open');
			});

			ws.on('message', (data) => {
				const text = payloadToString(data);
				if (!text) return;
				let parsed: unknown;
				try {
					parsed = JSON.parse(text);
				} catch (err) {
					this.lastError =
						err instanceof Error ? err.message : 'malformed upstream payload';
					this.broadcastStatus('degraded');
					return;
				}
				const projected = projectByEndpoint(this.endpoint, parsed);
				this.cachedSnapshot = projected;
				if (this.status !== 'open') this.broadcastStatus('open');
				for (const sub of this.subscribers) {
					try {
						sub.onSnapshot(projected);
					} catch {
						// don't let one slow consumer break the fan-out
					}
				}
			});

			ws.on('error', (err) => {
				this.lastError = err instanceof Error ? err.message : String(err);
			});

			ws.on('close', () => {
				if (openTimeout) {
					clearTimeout(openTimeout);
					openTimeout = null;
				}
				this.ws = null;
				this.opened = false;
				if (this.disposed) {
					this.broadcastStatus('closed');
					return;
				}
				if (this.subscribers.size === 0) {
					this.broadcastStatus('closed');
					return;
				}
				this.scheduleReconnect();
			});
		} catch (err) {
			this.lastError = err instanceof Error ? err.message : String(err);
			this.scheduleReconnect();
		}
	}

	private scheduleReconnect(): void {
		if (this.disposed || this.reconnectTimer) return;
		const exp = Math.min(
			RECONNECT_MAX_MS,
			RECONNECT_MIN_MS * 2 ** Math.min(this.reconnectAttempt, 6),
		);
		const delay = Math.max(RECONNECT_MIN_MS, jittered(exp));
		this.reconnectAttempt += 1;
		this.broadcastStatus('degraded');
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			if (this.subscribers.size > 0 && !this.disposed) {
				this.openUpstream();
			}
		}, delay);
	}

	private closeUpstream(reason: 'idle' | 'shutdown'): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.ws) {
			try {
				this.ws.close(1000, reason);
			} catch {
				/* ignore */
			}
			this.ws = null;
		}
		this.cachedSnapshot = null;
		this.broadcastStatus('closed');
	}

	private broadcastStatus(state: StreamStatus): void {
		this.status = state;
		const event: StatusEvent = {
			state,
			error: this.lastError ?? undefined,
			at: nowIso(),
		};
		for (const sub of this.subscribers) {
			try {
				sub.onStatus(event);
			} catch {
				// ignore
			}
		}
	}

	dispose(): void {
		this.disposed = true;
		this.subscribers.clear();
		this.closeUpstream('shutdown');
	}
}

class SubscriberPool {
	private streams = new Map<string, UpstreamStream>();
	private disposed = false;

	subscribe(
		endpoint: EndpointKey,
		params: Record<string, string>,
		subscriber: Subscriber,
	): () => void {
		if (this.disposed) {
			subscriber.onStatus({
				state: 'closed',
				error: 'pool disposed',
				at: nowIso(),
			});
			return () => {};
		}
		const key = poolCacheKey(endpoint, params);
		let stream = this.streams.get(key);
		if (!stream) {
			stream = new UpstreamStream(key, endpoint, filterParams(endpoint, params));
			this.streams.set(key, stream);
		}
		const unsubscribe = stream.subscribe(subscriber);
		return () => {
			unsubscribe();
			// GC streams that have been idle (no subscribers, no upstream).
			if (stream && stream.subscriberCount === 0 && stream.currentStatus === 'closed') {
				this.streams.delete(key);
			}
		};
	}

	stats(): Array<{ key: string; subscribers: number; status: StreamStatus }> {
		return Array.from(this.streams.entries()).map(([key, stream]) => ({
			key,
			subscribers: stream.subscriberCount,
			status: stream.currentStatus,
		}));
	}

	shutdown(): void {
		this.disposed = true;
		for (const stream of this.streams.values()) stream.dispose();
		this.streams.clear();
	}
}

function filterParams(
	endpoint: EndpointKey,
	params: Record<string, string>,
): Record<string, string> {
	const desc = ENDPOINTS[endpoint];
	const allowedKeys = new Set<string>([...desc.pathParams, ...desc.query]);
	const out: Record<string, string> = {};
	for (const key of allowedKeys) {
		const v = params[key];
		if (typeof v === 'string' && v.length > 0) out[key] = v;
	}
	return out;
}

function nowIso(): string {
	return new Date().toISOString();
}

// Singleton hosted on globalThis so HMR + repeated module imports share it.
type GlobalWithPool = typeof globalThis & {
	__kueueviz_pool?: SubscriberPool;
	__kueueviz_pool_disposer?: boolean;
};
const g = globalThis as GlobalWithPool;
if (!g.__kueueviz_pool) {
	g.__kueueviz_pool = new SubscriberPool();
}
export const kueuevizPool: SubscriberPool = g.__kueueviz_pool;

// HMR: dispose upstream sockets cleanly when this module reloads.
// Without this, every devspace file-sync iteration leaks one WS per
// active topic to kueue-kueueviz-backend.
if (import.meta.hot && !g.__kueueviz_pool_disposer) {
	g.__kueueviz_pool_disposer = true;
	import.meta.hot.dispose(() => {
		kueuevizPool.shutdown();
		g.__kueueviz_pool = undefined;
		g.__kueueviz_pool_disposer = false;
	});
}

export { SNAPSHOT_QUEUE_LIMIT };

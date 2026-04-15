/**
 * Singleton NATS JetStream connection for direct event streaming.
 *
 * Bypasses Dapr sidecar on the read path to access JetStream consumer APIs
 * (ephemeral consumers, filterSubject, deliverPolicy) that Dapr pub/sub
 * doesn't expose.
 *
 * Write path still goes through Dapr pub/sub (agents stay broker-agnostic).
 */

import { createRequire } from 'node:module';
import type { NatsConnection, JetStreamClient, JetStreamManager } from 'nats';
import { env } from '$env/dynamic/private';

const NATS_URL = env.NATS_URL || 'nats://nats.nats.svc.cluster.local:4222';
const STREAM_NAME = env.NATS_STREAM_NAME || 'ORCHESTRATOR';

let connectionPromise: Promise<NatsConnection> | null = null;
let nc: NatsConnection | null = null;
let natsModule: typeof import('nats') | null = null;

const require = createRequire(import.meta.url);

function loadNats(): typeof import('nats') {
	if (!natsModule) {
		natsModule = require('nats') as typeof import('nats');
	}
	return natsModule;
}

/**
 * Get a shared NATS connection. Lazy-connects on first call.
 * Auto-reconnects on disconnect.
 */
export async function getNatsConnection(): Promise<NatsConnection> {
	if (nc && !nc.isClosed()) {
		return nc;
	}

	if (connectionPromise) {
		return connectionPromise;
	}

	connectionPromise = (async () => {
		try {
			const { connect } = loadNats();
			const conn = await connect({
				servers: NATS_URL,
				name: 'workflow-builder',
				reconnect: true,
				maxReconnectAttempts: -1, // infinite
				reconnectTimeWait: 2000,
				pingInterval: 30_000,
				maxPingOut: 3,
			});

			nc = conn;

			// Monitor connection status
			(async () => {
				for await (const s of conn.status()) {
					if (s.type === 'disconnect' || s.type === 'error') {
						console.warn(`[nats] ${s.type}:`, s.data);
					} else if (s.type === 'reconnect') {
						console.log('[nats] Reconnected');
					}
				}
			})().catch(() => {});

			conn.closed().then(() => {
				console.log('[nats] Connection closed');
				nc = null;
				connectionPromise = null;
			});

			console.log(`[nats] Connected to ${NATS_URL}`);
			return conn;
		} catch (err) {
			connectionPromise = null;
			throw err;
		}
	})();

	return connectionPromise;
}

/**
 * Get a JetStream client for consuming messages.
 */
export async function getJetStream(): Promise<JetStreamClient> {
	const conn = await getNatsConnection();
	return conn.jetstream();
}

/**
 * Get a JetStream manager for creating consumers.
 */
export async function getJetStreamManager(): Promise<JetStreamManager> {
	const conn = await getNatsConnection();
	return conn.jetstreamManager();
}

/** The NATS JetStream stream name for workflow events */
export const WORKFLOW_STREAM_NAME = STREAM_NAME;

/** Build a NATS subject for a specific execution's events */
export function executionSubject(executionId: string): string {
	return `workflow.events.${executionId}`;
}

/**
 * Check if NATS is available (non-blocking).
 */
export function isNatsAvailable(): boolean {
	return nc !== null && !nc.isClosed();
}

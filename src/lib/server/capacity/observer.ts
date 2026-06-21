import { env as privEnv } from '$env/dynamic/private';
import type {
	CapacityObserverResult,
	CapacityObserverSnapshot,
	CapacityQueueSnapshot,
	CapacitySessionSnapshot,
} from '$lib/types/capacity';

const DEFAULT_OBSERVER_URL =
	'http://capacity-observer.workflow-builder.svc.cluster.local:8080';

function observerBaseUrl(): string {
	return (
		privEnv.CAPACITY_OBSERVER_URL ??
		process.env.CAPACITY_OBSERVER_URL ??
		DEFAULT_OBSERVER_URL
	)
		.trim()
		.replace(/\/+$/, '');
}

function observerTimeoutMs(): number {
	const raw =
		privEnv.CAPACITY_OBSERVER_TIMEOUT_MS ??
		process.env.CAPACITY_OBSERVER_TIMEOUT_MS ??
		'1800';
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 1800;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isSnapshot(value: unknown): value is CapacityObserverSnapshot {
	if (!isRecord(value)) return false;
	return (
		typeof value.sampledAt === 'string' &&
		typeof value.cluster === 'string' &&
		Array.isArray(value.resources) &&
		Array.isArray(value.queues) &&
		Array.isArray(value.sessionCapacity) &&
		Array.isArray(value.blockedWorkloads)
	);
}

export async function fetchCapacityObserverSnapshot(): Promise<CapacityObserverResult> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), observerTimeoutMs());
	try {
		const response = await fetch(`${observerBaseUrl()}/snapshot`, {
			signal: controller.signal,
			headers: { accept: 'application/json' },
		});
		if (!response.ok) {
			return {
				available: false,
				snapshot: null,
				error: `capacity observer returned HTTP ${response.status}`,
			};
		}
		const body = (await response.json().catch(() => null)) as unknown;
		if (!isSnapshot(body)) {
			return {
				available: false,
				snapshot: null,
				error: 'capacity observer returned an unexpected snapshot shape',
			};
		}
		return { available: true, snapshot: body, error: null };
	} catch (err) {
		return {
			available: false,
			snapshot: null,
			error: err instanceof Error ? err.message : String(err),
		};
	} finally {
		clearTimeout(timeout);
	}
}

export function queueFromObserver(
	snapshot: CapacityObserverSnapshot | null | undefined,
	queueName: string | null | undefined,
): CapacityQueueSnapshot | null {
	if (!snapshot || !queueName) return null;
	return snapshot.queues.find((queue) => queue.name === queueName) ?? null;
}

export function sessionCapacityFromObserver(
	snapshot: CapacityObserverSnapshot | null | undefined,
	executionClassOrQueue: string | null | undefined,
): CapacitySessionSnapshot | null {
	if (!snapshot || !executionClassOrQueue) return null;
	return (
		snapshot.sessionCapacity.find(
			(entry) =>
				entry.executionClass === executionClassOrQueue ||
				entry.queue === executionClassOrQueue,
		) ?? null
	);
}

export function summarizeCapacityObserverForQueue(params: {
	result: CapacityObserverResult;
	queueName?: string | null;
	executionClass?: string | null;
}):
	| {
			available: true;
			cluster: string;
			sampledAt: string;
			queue: string | null;
			pendingWorkloads: number | null;
			admittedWorkloads: number | null;
			fitsAdditionalSessions: number | null;
			error: null;
	  }
	| {
			available: false;
			cluster: null;
			sampledAt: null;
			queue: string | null;
			pendingWorkloads: null;
			admittedWorkloads: null;
			fitsAdditionalSessions: null;
			error: string;
	  } {
	if (!params.result.available) {
		return {
			available: false,
			cluster: null,
			sampledAt: null,
			queue: params.queueName ?? params.executionClass ?? null,
			pendingWorkloads: null,
			admittedWorkloads: null,
			fitsAdditionalSessions: null,
			error: params.result.error,
		};
	}
	const snapshot = params.result.snapshot;
	const queue =
		queueFromObserver(snapshot, params.queueName) ??
		queueFromObserver(snapshot, params.executionClass);
	const session =
		sessionCapacityFromObserver(snapshot, params.executionClass) ??
		sessionCapacityFromObserver(snapshot, params.queueName);
	return {
		available: true,
		cluster: snapshot.cluster,
		sampledAt: snapshot.sampledAt,
		queue: queue?.name ?? session?.queue ?? params.queueName ?? params.executionClass ?? null,
		pendingWorkloads: queue?.pendingWorkloads ?? null,
		admittedWorkloads: queue?.admittedWorkloads ?? null,
		fitsAdditionalSessions: session?.fits ?? null,
		error: null,
	};
}

/** One phase mark in a session's sandbox provisioning timeline (from observer). */
export interface ObserverProvisioningMark {
	phase: string;
	at: string;
	durationMs: number | null;
}

/** Per-session sandbox provisioning projection served by the observer's
 *  GET /provisioning?session_id= (Kueue admit → scheduled → pulling → init →
 *  running, with authoritative timestamps + durations). */
export interface ObserverSessionProvisioning {
	sessionId: string;
	podName: string | null;
	namespace: string | null;
	phase: string;
	terminal: boolean;
	failedReason: string | null;
	timeline: ObserverProvisioningMark[];
}

function isObserverProvisioning(value: unknown): value is ObserverSessionProvisioning {
	return (
		isRecord(value) &&
		typeof value.phase === 'string' &&
		Array.isArray(value.timeline)
	);
}

/** Fetch one session's provisioning timeline from the observer. Returns null when
 *  the observer is unavailable or has no record for the session (caller falls back
 *  to the direct-pod read). Best-effort + short timeout — never throws. */
export async function fetchSessionProvisioning(
	sessionId: string,
): Promise<ObserverSessionProvisioning | null> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), observerTimeoutMs());
	try {
		const url = `${observerBaseUrl()}/provisioning?session_id=${encodeURIComponent(sessionId)}`;
		const response = await fetch(url, {
			signal: controller.signal,
			headers: { accept: 'application/json' },
		});
		if (!response.ok) return null; // 404 = no record yet
		const body = (await response.json().catch(() => null)) as unknown;
		return isObserverProvisioning(body) ? body : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timeout);
	}
}

export const __capacityObserverForTest = {
	isSnapshot,
};

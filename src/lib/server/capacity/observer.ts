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

export const __capacityObserverForTest = {
	isSnapshot,
};

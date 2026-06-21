/**
 * Sandbox provisioning status for a session — fills the "no session events yet,
 * is it stuck or just booting?" gap. A per-session agent sandbox pod is labelled
 * `workflow-builder.cnoe.io/session-id=<sessionId>`; we read that pod from the
 * Kube API and project its lifecycle into a coarse provisioning phase the Live
 * view can show while the session is still `rescheduling`.
 *
 * No pod yet  → queued (awaiting Kueue admission)
 * Pending, unscheduled → scheduling
 * Pending, scheduled, init not ready → initializing
 * Pending, scheduled, container creating / image pull → pulling
 * Running, not all ready → starting
 * Running, ready → running
 */
import { eq } from 'drizzle-orm';
import { kubeApiFetch, getOwnNamespace, type KubePod } from '$lib/server/kube/client';
import { db } from '$lib/server/db';
import { sessions } from '$lib/server/db/schema';
import {
	fetchProvisioningByAppId,
	type ObserverSessionProvisioning
} from '$lib/server/capacity/observer';

export const SESSION_ID_LABEL = 'workflow-builder.cnoe.io/session-id';

export type ProvisioningPhase =
	| 'queued'
	| 'admitted'
	| 'scheduling'
	| 'pulling'
	| 'initializing'
	| 'starting'
	| 'running'
	| 'failed'
	| 'unknown';

export interface SessionProvisioningMark {
	phase: string;
	at: string;
	durationMs: number | null;
}

export interface SessionProvisioning {
	phase: ProvisioningPhase;
	label: string;
	detail: string | null;
	podName: string | null;
	podPhase: string | null;
	/** Ordered phase timeline w/ authoritative timestamps + durations (observer). */
	timeline?: SessionProvisioningMark[];
	source?: 'observer' | 'pod';
}

const PHASE_LABEL: Record<ProvisioningPhase, string> = {
	queued: 'Waiting for admission',
	admitted: 'Admitted — scheduling',
	scheduling: 'Scheduling pod',
	pulling: 'Pulling image',
	initializing: 'Initializing',
	starting: 'Starting containers',
	running: 'Sandbox ready',
	failed: 'Sandbox failed',
	unknown: 'Provisioning…'
};

function coercePhase(p: string): ProvisioningPhase {
	return (Object.keys(PHASE_LABEL) as ProvisioningPhase[]).includes(p as ProvisioningPhase)
		? (p as ProvisioningPhase)
		: 'unknown';
}

/** Map the observer's richer projection into the BFF SessionProvisioning shape. */
function fromObserver(o: ObserverSessionProvisioning): SessionProvisioning {
	const phase = coercePhase(o.phase);
	return {
		phase,
		label: o.failedReason ? `Sandbox failed (${o.failedReason})` : PHASE_LABEL[phase],
		detail: o.failedReason ?? null,
		podName: o.podName ?? null,
		podPhase: null,
		timeline: o.timeline ?? [],
		source: 'observer'
	};
}

function derive(pod: KubePod | null): SessionProvisioning {
	if (!pod) {
		return {
			phase: 'queued',
			label: 'Waiting for admission',
			detail: 'Queued for cluster capacity (Kueue)',
			podName: null,
			podPhase: null
		};
	}
	const podName = pod.metadata?.name ?? null;
	const podPhase = pod.status?.phase ?? null;
	const conds = pod.status?.conditions ?? [];
	const scheduled = conds.find((c) => c.type === 'PodScheduled')?.status === 'True';
	const initStatuses = pod.status?.initContainerStatuses ?? [];
	const containerStatuses = pod.status?.containerStatuses ?? [];
	const base = { podName, podPhase };

	if (podPhase === 'Failed') {
		return { ...base, phase: 'failed', label: 'Sandbox failed', detail: null };
	}
	if (podPhase === 'Running') {
		const allReady =
			containerStatuses.length > 0 && containerStatuses.every((c) => c.ready === true);
		return allReady
			? { ...base, phase: 'running', label: 'Sandbox ready', detail: null }
			: { ...base, phase: 'starting', label: 'Starting containers', detail: null };
	}
	// Pending (or Unknown)
	if (!scheduled) {
		return { ...base, phase: 'scheduling', label: 'Scheduling pod', detail: 'Placing on a node' };
	}
	if (initStatuses.length > 0 && initStatuses.some((c) => c.ready !== true)) {
		return { ...base, phase: 'initializing', label: 'Initializing', detail: 'Init containers' };
	}
	const waiting = containerStatuses.find((c) => c.state?.waiting)?.state?.waiting;
	const reason = waiting?.reason;
	if (reason === 'ImagePullBackOff' || reason === 'ErrImagePull') {
		return { ...base, phase: 'pulling', label: 'Image pull failing', detail: reason };
	}
	if (reason === 'ContainerCreating' || reason === 'PodInitializing') {
		return { ...base, phase: 'pulling', label: 'Pulling image', detail: 'Creating container' };
	}
	return { ...base, phase: 'scheduling', label: 'Preparing sandbox', detail: reason ?? null };
}

/** Read the session's sandbox pod (by session-id label) and project its phase. */
export async function getSessionProvisioning(sessionId: string): Promise<SessionProvisioning> {
	try {
		const ns = await getOwnNamespace();
		const selector = encodeURIComponent(`${SESSION_ID_LABEL}=${sessionId}`);
		const res = await kubeApiFetch(
			`/api/v1/namespaces/${encodeURIComponent(ns)}/pods?labelSelector=${selector}`
		);
		if (!res.ok) return derive(null);
		const body = (await res.json()) as { items?: KubePod[] };
		const pods = body.items ?? [];
		if (pods.length === 0) return derive(null);
		// Newest pod (a recreated sandbox supersedes an old one).
		const pod = pods.sort((a, b) =>
			(b.metadata?.creationTimestamp ?? '').localeCompare(a.metadata?.creationTimestamp ?? '')
		)[0];
		return { ...derive(pod), source: 'pod' };
	} catch {
		return { phase: 'unknown', label: 'Provisioning…', detail: null, podName: null, podPhase: null, source: 'pod' };
	}
}

/**
 * Preferred resolver: the capacity-observer's richer timeline (admit→…→running
 * with durations), falling back to the direct-pod read when the observer is
 * unavailable or has no record for the session yet.
 *
 * The observer keys its map by the per-session sandbox app-id (the only stable
 * per-session identifier on the pod — the `cnoe.io/session-id` label is the
 * sanitized parent instance, shared across a run's node pods). So we look up the
 * session's `runtime_app_id` and query the observer by that.
 */
export async function getSessionProvisioningPreferObserver(
	sessionId: string
): Promise<SessionProvisioning> {
	let runtimeAppId: string | null = null;
	if (db) {
		const [row] = await db
			.select({ runtimeAppId: sessions.runtimeAppId })
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1);
		runtimeAppId = row?.runtimeAppId ?? null;
	}
	if (runtimeAppId) {
		const observed = await fetchProvisioningByAppId(runtimeAppId);
		if (observed) return fromObserver(observed);
	}
	return getSessionProvisioning(sessionId);
}

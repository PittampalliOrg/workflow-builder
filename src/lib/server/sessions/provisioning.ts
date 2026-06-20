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
import { kubeApiFetch, getOwnNamespace, type KubePod } from '$lib/server/kube/client';

export const SESSION_ID_LABEL = 'workflow-builder.cnoe.io/session-id';

export type ProvisioningPhase =
	| 'queued'
	| 'scheduling'
	| 'pulling'
	| 'initializing'
	| 'starting'
	| 'running'
	| 'failed'
	| 'unknown';

export interface SessionProvisioning {
	phase: ProvisioningPhase;
	label: string;
	detail: string | null;
	podName: string | null;
	podPhase: string | null;
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
		return derive(pod);
	} catch {
		return { phase: 'unknown', label: 'Provisioning…', detail: null, podName: null, podPhase: null };
	}
}

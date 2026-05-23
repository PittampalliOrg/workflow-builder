import { daprFetch, getOrchestratorUrl } from "$lib/server/dapr-client";
import {
	kubeApiFetch,
	listDeployments,
	listPods,
	type KubePod,
} from "$lib/server/kube/client";

export type ParentWorkflowRuntimeSnapshot = {
	parentAppId: string;
	namespace: string;
	configName: string;
	replicas: number | null;
	readyReplicas: number | null;
	availableReplicas: number | null;
	connectedWorkflowWorkers: number | null;
	workflowLimitPerSidecar: number | null;
	activityLimitPerSidecar: number | null;
	effectiveWorkflowCapacity: number | null;
	effectiveActivityCapacity: number | null;
	daprRuntimeVersion: string | null;
	schedulerPods: number | null;
	schedulerReadyPods: number | null;
	recentActorErrorCount: number | null;
	recentReminderErrorCount: number | null;
	logWindowSeconds: number;
	daprRuntimePressure: boolean;
	error: string | null;
};

const DEFAULT_NAMESPACE = "workflow-builder";
const DEFAULT_PARENT_APP_ID = "workflow-orchestrator";
const DEFAULT_CONFIGURATION = "workflow-builder-tracing";
const DAPR_LOG_WINDOW_SECONDS = 30 * 60;

function positiveInt(value: unknown): number | null {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim()
				? Number.parseInt(value, 10)
				: Number.NaN;
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeInt(value: unknown): number | null {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim()
				? Number.parseInt(value, 10)
				: Number.NaN;
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function podIsReady(pod: KubePod): boolean {
	return (
		pod.status?.phase === "Running" &&
		pod.status.conditions?.some(
			(condition) => condition.type === "Ready" && condition.status === "True",
		) === true
	);
}

function podMatchesApp(pod: KubePod, appId: string): boolean {
	const labels = pod.metadata?.labels ?? {};
	return labels.app === appId || labels["app.kubernetes.io/name"] === appId;
}

function parseDaprVersionFromPod(pod: KubePod): string | null {
	const status = pod.status?.containerStatuses?.find(
		(container) => container.name === "daprd",
	);
	const image = status?.image ?? status?.imageID ?? null;
	if (!image) return null;
	const tag = image.match(/(?:^|[/@:])daprd[:@]([^@\s]+)/)?.[1] ?? null;
	if (!tag) return image;
	return tag.replace(/^v/, "");
}

function parseReadyz(body: unknown): number | null {
	if (!isRecord(body)) return null;
	return (
		nonNegativeInt(body.workflowConnectedWorkers) ??
		nonNegativeInt(body.connectedWorkflowWorkers) ??
		nonNegativeInt(body.connectedWorkers)
	);
}

async function loadConnectedWorkers(): Promise<number | null> {
	const res = await daprFetch(`${getOrchestratorUrl()}/readyz`, {
		method: "GET",
		maxRetries: 0,
		signal: AbortSignal.timeout(5_000),
	});
	if (!res.ok) {
		throw new Error(`workflow-orchestrator /readyz returned HTTP ${res.status}`);
	}
	return parseReadyz(await res.json().catch(() => null));
}

async function loadDaprConfiguration(params: {
	namespace: string;
	configName: string;
}): Promise<{
	workflowLimitPerSidecar: number | null;
	activityLimitPerSidecar: number | null;
}> {
	const res = await kubeApiFetch(
		`/apis/dapr.io/v1alpha1/namespaces/${encodeURIComponent(
			params.namespace,
		)}/configurations/${encodeURIComponent(params.configName)}`,
	);
	if (!res.ok) {
		throw new Error(
			`get Dapr Configuration ${params.namespace}/${params.configName} failed: ${
				res.status
			} ${await res.text()}`,
		);
	}
	const body = (await res.json()) as unknown;
	const spec = isRecord(body) ? body.spec : null;
	const workflow = isRecord(spec) ? spec.workflow : null;
	return {
		workflowLimitPerSidecar: isRecord(workflow)
			? positiveInt(workflow.maxConcurrentWorkflowInvocations)
			: null,
		activityLimitPerSidecar: isRecord(workflow)
			? positiveInt(workflow.maxConcurrentActivityInvocations)
			: null,
	};
}

function isSchedulerPod(pod: KubePod): boolean {
	const labels = pod.metadata?.labels ?? {};
	const name = pod.metadata?.name ?? "";
	return (
		name.includes("dapr-scheduler") ||
		labels["app.kubernetes.io/name"] === "dapr-scheduler" ||
		labels["app"] === "dapr-scheduler"
	);
}

async function countSchedulerPods(): Promise<{
	schedulerPods: number;
	schedulerReadyPods: number;
}> {
	const pods = await listPods("dapr-system");
	const schedulerPods = pods.filter(isSchedulerPod);
	return {
		schedulerPods: schedulerPods.length,
		schedulerReadyPods: schedulerPods.filter(podIsReady).length,
	};
}

function countLogMatches(logs: string): {
	actorErrors: number;
	reminderErrors: number;
} {
	let actorErrors = 0;
	let reminderErrors = 0;
	for (const line of logs.split(/\r?\n/)) {
		if (
			!/(level=(error|fatal)|ERR_|panic|deadline|unable|no such instance|\bfailed\b|\bfailure\b|\babort(?:ed)?\b|\blocked\b|\block timeout\b)/i.test(
				line,
			)
		) {
			continue;
		}
		if (/actor/i.test(line)) actorErrors += 1;
		if (/reminder|scheduler/i.test(line)) reminderErrors += 1;
	}
	return { actorErrors, reminderErrors };
}

async function countRecentDaprLogErrors(params: {
	namespace: string;
	pods: KubePod[];
}): Promise<{ actorErrors: number | null; reminderErrors: number | null }> {
	let actorErrors = 0;
	let reminderErrors = 0;
	for (const pod of params.pods) {
		const name = pod.metadata?.name;
		if (!name) continue;
		const query = new URLSearchParams({
			container: "daprd",
			sinceSeconds: String(DAPR_LOG_WINDOW_SECONDS),
			tailLines: "2000",
		});
		const res = await kubeApiFetch(
			`/api/v1/namespaces/${encodeURIComponent(params.namespace)}/pods/${encodeURIComponent(
				name,
			)}/log?${query.toString()}`,
		);
		if (!res.ok) {
			throw new Error(`read daprd logs for ${name} failed: HTTP ${res.status}`);
		}
		const counts = countLogMatches(await res.text());
		actorErrors += counts.actorErrors;
		reminderErrors += counts.reminderErrors;
	}
	return { actorErrors, reminderErrors };
}

export async function loadParentWorkflowRuntimeSnapshot(params: {
	namespace?: string;
	parentAppId?: string;
	configName?: string;
} = {}): Promise<ParentWorkflowRuntimeSnapshot> {
	const namespace = params.namespace ?? DEFAULT_NAMESPACE;
	const parentAppId = params.parentAppId ?? DEFAULT_PARENT_APP_ID;
	const configName = params.configName ?? DEFAULT_CONFIGURATION;
	const base = {
		parentAppId,
		namespace,
		configName,
		logWindowSeconds: DAPR_LOG_WINDOW_SECONDS,
	};

	try {
		const [deployments, pods, config, connectedWorkers, scheduler] =
			await Promise.all([
				listDeployments(namespace),
				listPods(namespace),
				loadDaprConfiguration({ namespace, configName }),
				loadConnectedWorkers().catch((err) => {
					console.warn("[bench-capacity] orchestrator /readyz unavailable", err);
					return null;
				}),
				countSchedulerPods().catch((err) => {
					console.warn("[bench-capacity] Dapr scheduler pod count unavailable", err);
					return { schedulerPods: null, schedulerReadyPods: null };
				}),
			]);
		const deployment = deployments.find(
			(item) => item.metadata?.name === parentAppId,
		);
		const parentPods = pods.filter((pod) => podMatchesApp(pod, parentAppId));
		const replicas =
			positiveInt(deployment?.spec?.replicas) ??
			positiveInt(deployment?.status?.replicas) ??
			null;
		const readyReplicas = nonNegativeInt(deployment?.status?.readyReplicas);
		const availableReplicas = nonNegativeInt(
			deployment?.status?.availableReplicas,
		);
		const workflowCapacity =
			replicas && config.workflowLimitPerSidecar
				? replicas * config.workflowLimitPerSidecar
				: null;
		const activityCapacity =
			replicas && config.activityLimitPerSidecar
				? replicas * config.activityLimitPerSidecar
				: null;
		let logCounts: { actorErrors: number | null; reminderErrors: number | null };
		try {
			logCounts = await countRecentDaprLogErrors({
				namespace,
				pods: parentPods,
			});
		} catch (err) {
			console.warn("[bench-capacity] daprd log scan unavailable", err);
			logCounts = { actorErrors: null, reminderErrors: null };
		}
		const daprRuntimeVersion =
			parentPods.map(parseDaprVersionFromPod).find(Boolean) ?? null;
		const daprRuntimePressure =
			(logCounts.actorErrors ?? 0) > 0 ||
			(logCounts.reminderErrors ?? 0) > 0 ||
			(replicas != null &&
				connectedWorkers != null &&
				connectedWorkers < Math.min(replicas, readyReplicas ?? replicas));

		return {
			...base,
			replicas,
			readyReplicas,
			availableReplicas,
			connectedWorkflowWorkers: connectedWorkers,
			workflowLimitPerSidecar: config.workflowLimitPerSidecar,
			activityLimitPerSidecar: config.activityLimitPerSidecar,
			effectiveWorkflowCapacity: workflowCapacity,
			effectiveActivityCapacity: activityCapacity,
			daprRuntimeVersion,
			schedulerPods: scheduler.schedulerPods,
			schedulerReadyPods: scheduler.schedulerReadyPods,
			recentActorErrorCount: logCounts.actorErrors,
			recentReminderErrorCount: logCounts.reminderErrors,
			daprRuntimePressure,
			error: null,
		};
	} catch (err) {
		return {
			...base,
			replicas: null,
			readyReplicas: null,
			availableReplicas: null,
			connectedWorkflowWorkers: null,
			workflowLimitPerSidecar: null,
			activityLimitPerSidecar: null,
			effectiveWorkflowCapacity: null,
			effectiveActivityCapacity: null,
			daprRuntimeVersion: null,
			schedulerPods: null,
			schedulerReadyPods: null,
			recentActorErrorCount: null,
			recentReminderErrorCount: null,
			daprRuntimePressure: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export const __daprWorkflowCapacityForTest = {
	countLogMatches,
};

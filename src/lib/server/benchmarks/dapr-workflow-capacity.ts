import { kubeApiFetch, listDeployments, listPods, type KubePod } from "$lib/server/kube/client";

export type ParentWorkflowPodWorkerSnapshot = {
	podName: string;
	ready: boolean;
	podIP: string | null;
	connectedWorkflowWorkers: number | null;
	error: string | null;
};

export type ParentWorkflowRuntimeSnapshot = {
	parentAppId: string;
	namespace: string;
	configName: string;
	replicas: number | null;
	readyReplicas: number | null;
	availableReplicas: number | null;
	connectedWorkflowWorkers: number | null;
	connectedWorkerPods: number | null;
	podWorkers: ParentWorkflowPodWorkerSnapshot[];
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

export type AgentHostDaprRuntimeSnapshot = {
	namespace: string;
	activePods: number;
	unhealthyPods: string[];
	appContainerOomKilledPods: string[];
	recentActorErrorCount: number | null;
	recentReminderErrorCount: number | null;
	logWindowSeconds: number;
	daprRuntimePressure: boolean;
	pressureReasons: string[];
	error: string | null;
};

const DEFAULT_NAMESPACE = "workflow-builder";
const DEFAULT_PARENT_APP_ID = "workflow-orchestrator";
const DEFAULT_CONFIGURATION = "workflow-builder-tracing";
const DEFAULT_DAPR_LOG_WINDOW_SECONDS = 5 * 60;
const DEFAULT_READYZ_PORT = 8080;

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
	const deletionTimestamp = (pod.metadata as { deletionTimestamp?: string | null } | undefined)
		?.deletionTimestamp;
	return (
		pod.status?.phase === "Running" &&
		deletionTimestamp == null &&
		pod.status.conditions?.some(
			(condition) => condition.type === "Ready" && condition.status === "True",
		) === true
	);
}

function podMatchesApp(pod: KubePod, appId: string): boolean {
	const labels = pod.metadata?.labels ?? {};
	return labels.app === appId || labels["app.kubernetes.io/name"] === appId;
}

function podIsDeleting(pod: KubePod): boolean {
	return (
		(pod.metadata as { deletionTimestamp?: string | null } | undefined)?.deletionTimestamp != null
	);
}

function podIsActive(pod: KubePod): boolean {
	return !podIsDeleting(pod) && pod.status?.phase === "Running";
}

function podIsAgentHost(pod: KubePod): boolean {
	const name = pod.metadata?.name ?? "";
	const labels = pod.metadata?.labels ?? {};
	return (
		name.startsWith("agent-host-agent-session-") ||
		labels["app.kubernetes.io/component"] === "agent-host" ||
		labels["workflow-builder.io/runtime-kind"] === "agent-host"
	);
}

function appContainerWasOomKilled(pod: KubePod): boolean {
	return (
		pod.status?.containerStatuses?.some(
			(status) =>
				status.name !== "daprd" &&
				(status.state?.terminated?.reason === "OOMKilled" ||
					status.lastState?.terminated?.reason === "OOMKilled"),
		) === true
	);
}

function parseDaprVersionFromPod(pod: KubePod): string | null {
	const status = pod.status?.containerStatuses?.find((container) => container.name === "daprd");
	const image = status?.image ?? status?.imageID ?? null;
	if (!image) return null;
	const tag = image.match(/(?:^|[/@:])daprd[:@]([^@\s]+)/)?.[1] ?? null;
	if (!tag) return image;
	return tag.replace(/^v/, "");
}

function readyzPort(): number {
	return (
		positiveInt(process.env.BENCHMARK_PARENT_WORKFLOW_READYZ_PORT) ??
		positiveInt(process.env.WORKFLOW_ORCHESTRATOR_PORT) ??
		DEFAULT_READYZ_PORT
	);
}

function daprLogWindowSeconds(): number {
	return (
		positiveInt(process.env.BENCHMARK_DAPR_LOG_WINDOW_SECONDS) ?? DEFAULT_DAPR_LOG_WINDOW_SECONDS
	);
}

function parseReadyz(body: unknown): number | null {
	if (!isRecord(body)) return null;
	const direct =
		nonNegativeInt(body.workflowConnectedWorkers) ??
		nonNegativeInt(body.connectedWorkflowWorkers) ??
		nonNegativeInt(body.connectedWorkers);
	if (direct != null) return direct;
	for (const value of Object.values(body)) {
		if (Array.isArray(value)) {
			for (const item of value) {
				const nested = parseReadyz(item);
				if (nested != null) return nested;
			}
		} else {
			const nested = parseReadyz(value);
			if (nested != null) return nested;
		}
	}
	return null;
}

async function loadPodConnectedWorkers(pod: KubePod): Promise<ParentWorkflowPodWorkerSnapshot> {
	const podName = pod.metadata?.name ?? "unknown";
	const podIP = pod.status?.podIP ?? null;
	if (!podIP) {
		return {
			podName,
			ready: podIsReady(pod),
			podIP: null,
			connectedWorkflowWorkers: null,
			error: "pod has no IP",
		};
	}
	try {
		const res = await fetch(`http://${podIP}:${readyzPort()}/readyz`, {
			method: "GET",
			signal: AbortSignal.timeout(5_000),
		});
		if (!res.ok) {
			return {
				podName,
				ready: podIsReady(pod),
				podIP,
				connectedWorkflowWorkers: null,
				error: `/readyz returned HTTP ${res.status}`,
			};
		}
		const body = await res.json().catch(() => null);
		const connectedWorkflowWorkers = parseReadyz(body);
		return {
			podName,
			ready: podIsReady(pod),
			podIP,
			connectedWorkflowWorkers,
			error:
				connectedWorkflowWorkers == null ? "/readyz did not expose workflowConnectedWorkers" : null,
		};
	} catch (err) {
		return {
			podName,
			ready: podIsReady(pod),
			podIP,
			connectedWorkflowWorkers: null,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

async function loadConnectedWorkers(pods: KubePod[]): Promise<{
	connectedWorkflowWorkers: number | null;
	connectedWorkerPods: number | null;
	podWorkers: ParentWorkflowPodWorkerSnapshot[];
}> {
	const readyPods = pods.filter(podIsReady);
	const podWorkers = await Promise.all(readyPods.map(loadPodConnectedWorkers));
	const knownWorkers = podWorkers
		.map((entry) => entry.connectedWorkflowWorkers)
		.filter((entry): entry is number => entry !== null);
	return {
		connectedWorkflowWorkers:
			knownWorkers.length > 0 ? knownWorkers.reduce((sum, value) => sum + value, 0) : null,
		connectedWorkerPods:
			knownWorkers.length > 0
				? podWorkers.filter((entry) => (entry.connectedWorkflowWorkers ?? 0) > 0).length
				: null,
		podWorkers,
	};
}

async function loadDaprConfiguration(params: { namespace: string; configName: string }): Promise<{
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

function countLogMatches(
	logs: string,
	options: {
		ignoreRecoverableActorChurn?: boolean;
		ignoreActorLockTimeouts?: boolean;
	} = {},
): {
	actorErrors: number;
	reminderErrors: number;
} {
	const ignoreRecoverableActorChurn =
		options.ignoreRecoverableActorChurn ?? true;
	const ignoreActorLockTimeouts = options.ignoreActorLockTimeouts ?? true;
	let actorErrors = 0;
	let reminderErrors = 0;
	for (const line of logs.split(/\r?\n/)) {
		if (
			/Scheduler stream disconnected/i.test(line) &&
			/(server is closing|client connection is closing|context canceled|transport is closing)/i.test(
				line,
			)
		) {
			continue;
		}
		if (
			ignoreRecoverableActorChurn &&
			/Workflow actor .*execution failed with a recoverable error and will be retried later/i.test(
				line,
			) &&
			/context canceled|the app may not be available/i.test(line)
		) {
			continue;
		}
		if (/Timed out waiting for actor in-flight lock claims to be released/i.test(line)) {
			if (ignoreActorLockTimeouts) continue;
			actorErrors += 1;
			continue;
		}
		if (
			/Workflow actor .*cannot add event to workflow as state has been purged\. Ignoring event/i.test(
				line,
			)
		) {
			continue;
		}
		if (
			/failed to submit termination request to sub-orchestration/i.test(line) &&
			/no such instance exists/i.test(line)
		) {
			continue;
		}
		if (
			/Workflow actor .*execution failed with a recoverable error and will be retried later/i.test(
				line,
			) &&
			/execution aborted/i.test(line)
		) {
			continue;
		}
		if (
			/failed to invoke scheduled actor reminder named:/i.test(line) &&
			/execution aborted/i.test(line)
		) {
			continue;
		}
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
	windowSeconds: number;
	includeUnready?: boolean;
	ignoreRecoverableActorChurn?: boolean;
	ignoreActorLockTimeouts?: boolean;
}): Promise<{ actorErrors: number | null; reminderErrors: number | null }> {
	let actorErrors = 0;
	let reminderErrors = 0;
	const pods = params.includeUnready
		? params.pods.filter(podIsActive)
		: params.pods.filter(podIsReady);
	for (const pod of pods) {
		const name = pod.metadata?.name;
		if (!name) continue;
		const query = new URLSearchParams({
			container: "daprd",
			sinceSeconds: String(params.windowSeconds),
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
		const counts = countLogMatches(await res.text(), {
			ignoreRecoverableActorChurn: params.ignoreRecoverableActorChurn,
			ignoreActorLockTimeouts: params.ignoreActorLockTimeouts,
		});
		actorErrors += counts.actorErrors;
		reminderErrors += counts.reminderErrors;
	}
	return { actorErrors, reminderErrors };
}

export async function loadAgentHostDaprRuntimeSnapshot(
	params: {
		namespace?: string;
	} = {},
): Promise<AgentHostDaprRuntimeSnapshot> {
	const namespace = params.namespace ?? DEFAULT_NAMESPACE;
	const logWindowSeconds = daprLogWindowSeconds();
	try {
		const pods = await listPods(namespace);
		const activePods = pods.filter((pod) => podIsAgentHost(pod) && podIsActive(pod));
		const unhealthyPods = activePods
			.filter((pod) => !podIsReady(pod))
			.map((pod) => pod.metadata?.name ?? "unknown");
		const appContainerOomKilledPods = activePods
			.filter(appContainerWasOomKilled)
			.map((pod) => pod.metadata?.name ?? "unknown");
		let logCounts: {
			actorErrors: number | null;
			reminderErrors: number | null;
		};
		try {
			logCounts = await countRecentDaprLogErrors({
				namespace,
				pods: activePods,
				windowSeconds: logWindowSeconds,
				includeUnready: true,
				ignoreRecoverableActorChurn: false,
				ignoreActorLockTimeouts: false,
			});
		} catch (err) {
			console.warn("[bench-capacity] agent-host daprd log scan unavailable", err);
			logCounts = { actorErrors: null, reminderErrors: null };
		}
		const pressureReasons = [
			...(unhealthyPods.length > 0 ? ["agent_host_unhealthy"] : []),
			...(appContainerOomKilledPods.length > 0 ? ["agent_host_oom_killed"] : []),
			...((logCounts.actorErrors ?? 0) > 0 ? ["agent_host_actor_errors"] : []),
			...((logCounts.reminderErrors ?? 0) > 0 ? ["agent_host_reminder_errors"] : []),
		];
		return {
			namespace,
			activePods: activePods.length,
			unhealthyPods,
			appContainerOomKilledPods,
			recentActorErrorCount: logCounts.actorErrors,
			recentReminderErrorCount: logCounts.reminderErrors,
			logWindowSeconds,
			daprRuntimePressure: pressureReasons.length > 0,
			pressureReasons,
			error: null,
		};
	} catch (err) {
		return {
			namespace,
			activePods: 0,
			unhealthyPods: [],
			appContainerOomKilledPods: [],
			recentActorErrorCount: null,
			recentReminderErrorCount: null,
			logWindowSeconds,
			daprRuntimePressure: false,
			pressureReasons: [],
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export async function loadParentWorkflowRuntimeSnapshot(
	params: {
		namespace?: string;
		parentAppId?: string;
		configName?: string;
	} = {},
): Promise<ParentWorkflowRuntimeSnapshot> {
	const namespace = params.namespace ?? DEFAULT_NAMESPACE;
	const parentAppId = params.parentAppId ?? DEFAULT_PARENT_APP_ID;
	const configName = params.configName ?? DEFAULT_CONFIGURATION;
	const logWindowSeconds = daprLogWindowSeconds();
	const base = {
		parentAppId,
		namespace,
		configName,
		logWindowSeconds,
	};

	try {
		const [deployments, pods, config, scheduler] = await Promise.all([
			listDeployments(namespace),
			listPods(namespace),
			loadDaprConfiguration({ namespace, configName }),
			countSchedulerPods().catch((err) => {
				console.warn("[bench-capacity] Dapr scheduler pod count unavailable", err);
				return { schedulerPods: null, schedulerReadyPods: null };
			}),
		]);
		const deployment = deployments.find((item) => item.metadata?.name === parentAppId);
		const parentPods = pods.filter((pod) => podMatchesApp(pod, parentAppId));
		const connectedWorkers = await loadConnectedWorkers(parentPods);
		const replicas =
			positiveInt(deployment?.spec?.replicas) ?? positiveInt(deployment?.status?.replicas) ?? null;
		const readyReplicas = nonNegativeInt(deployment?.status?.readyReplicas);
		const availableReplicas = nonNegativeInt(deployment?.status?.availableReplicas);
		const connectedWorkerPods = connectedWorkers.connectedWorkerPods;
		const effectiveSidecars = connectedWorkerPods ?? readyReplicas ?? replicas ?? availableReplicas;
		const workflowCapacity =
			effectiveSidecars != null && config.workflowLimitPerSidecar
				? effectiveSidecars * config.workflowLimitPerSidecar
				: null;
		const activityCapacity =
			effectiveSidecars != null && config.activityLimitPerSidecar
				? effectiveSidecars * config.activityLimitPerSidecar
				: null;
		let logCounts: {
			actorErrors: number | null;
			reminderErrors: number | null;
		};
		try {
			logCounts = await countRecentDaprLogErrors({
				namespace,
				pods: parentPods,
				windowSeconds: logWindowSeconds,
			});
		} catch (err) {
			console.warn("[bench-capacity] daprd log scan unavailable", err);
			logCounts = { actorErrors: null, reminderErrors: null };
		}
		const daprRuntimeVersion = parentPods.map(parseDaprVersionFromPod).find(Boolean) ?? null;
		const daprRuntimePressure =
			(logCounts.actorErrors ?? 0) > 0 ||
			(logCounts.reminderErrors ?? 0) > 0 ||
			(replicas != null &&
				connectedWorkerPods != null &&
				connectedWorkerPods < Math.min(replicas, readyReplicas ?? replicas));

		return {
			...base,
			replicas,
			readyReplicas,
			availableReplicas,
			connectedWorkflowWorkers: connectedWorkers.connectedWorkflowWorkers,
			connectedWorkerPods,
			podWorkers: connectedWorkers.podWorkers,
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
			connectedWorkerPods: null,
			podWorkers: [],
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
	appContainerWasOomKilled,
	countLogMatches,
	daprLogWindowSeconds,
	podIsAgentHost,
	podIsReady,
	parseReadyz,
};

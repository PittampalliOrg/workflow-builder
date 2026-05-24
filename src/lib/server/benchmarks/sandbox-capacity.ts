import {
	kubeApiFetch,
	listNodes,
	listPods,
	listPodsAllNamespaces,
	type KubeContainerSpec,
	type KubeNode,
	type KubePod,
} from "$lib/server/kube/client";

export type BenchmarkSandboxCapacitySnapshot = {
	sampledAt: string;
	namespace: string;
	podScope: "all-namespaces" | "namespace";
	nodeCount: number;
	allocatableCpuMilli: number;
	allocatableMemoryBytes: number;
	allocatableEphemeralStorageBytes: number;
	requestedCpuMilli: number;
	requestedMemoryBytes: number;
	requestedEphemeralStorageBytes: number;
	pendingSwebenchCpuMilli: number;
	pendingSwebenchMemoryBytes: number;
	pendingSwebenchEphemeralStorageBytes: number;
	availableCpuMilli: number;
	availableMemoryBytes: number;
	availableEphemeralStorageBytes: number;
	sandboxRequestCpuMilli: number;
	sandboxRequestMemoryBytes: number;
	sandboxRequestEphemeralStorageBytes: number;
	availableSandboxSlots: number;
	totalSchedulableSandboxCapacity: number;
	schedulableSandboxCapacity: number;
	cpuLimitedCapacity: number;
	memoryLimitedCapacity: number;
	ephemeralStorageLimitedCapacity: number | null;
	nodeFsAvailableBytes: number | null;
	nodeFsCapacityBytes: number | null;
	nodeFsEvictionReserveBytes: number;
	nodeFsLimitedCapacity: number | null;
	kueueClusterQueueName: string | null;
	kueueClusterQueueActive: boolean | null;
	kueueClusterQueueReason: string | null;
	kueueClusterQueueMessage: string | null;
	kueueAvailableSandboxSlots: number | null;
	kueueBorrowAvailableSandboxSlots: number | null;
	kueueCpuLimitedCapacity: number | null;
	kueueMemoryLimitedCapacity: number | null;
	kueueEphemeralStorageLimitedCapacity: number | null;
	kueuePodLimitedCapacity: number | null;
	kueueInstanceRequestCpuMilli: number | null;
	kueueInstanceRequestMemoryBytes: number | null;
	kueueInstanceRequestEphemeralStorageBytes: number | null;
	kueueInstancePodCount: number | null;
	kueueAvailableInstanceSlots: number | null;
	kueueBorrowAvailableInstanceSlots: number | null;
	kueueInstanceCpuLimitedCapacity: number | null;
	kueueInstanceMemoryLimitedCapacity: number | null;
	kueueInstanceEphemeralStorageLimitedCapacity: number | null;
	kueueInstancePodLimitedCapacity: number | null;
	schedulableKueueInstanceCapacity: number | null;
	activeSwebenchPods: number;
	pendingSwebenchPods: number;
	diskPressureNodeCount: number;
	error?: string;
};

export type BenchmarkKueueCapacitySnapshot = {
	clusterQueueName: string;
	clusterQueueActive: boolean | null;
	clusterQueueReason: string | null;
	clusterQueueMessage: string | null;
	availableSandboxSlots: number;
	cpuLimitedCapacity: number | null;
	memoryLimitedCapacity: number | null;
	ephemeralStorageLimitedCapacity: number | null;
	podLimitedCapacity: number | null;
	availableCpuMilli: number | null;
	availableMemoryBytes: number | null;
	availableEphemeralStorageBytes: number | null;
	availablePods: number | null;
	borrowAvailableSandboxSlots: number | null;
	instanceRequestCpuMilli: number | null;
	instanceRequestMemoryBytes: number | null;
	instanceRequestEphemeralStorageBytes: number | null;
	instancePodCount: number | null;
	availableInstanceSlots: number | null;
	borrowAvailableInstanceSlots: number | null;
	instanceCpuLimitedCapacity: number | null;
	instanceMemoryLimitedCapacity: number | null;
	instanceEphemeralStorageLimitedCapacity: number | null;
	instancePodLimitedCapacity: number | null;
};

export type BenchmarkSandboxResourceProfile = {
	cpuMilli: number;
	memoryBytes: number;
	ephemeralStorageBytes: number;
};

const DEFAULT_SANDBOX_REQUEST_CPU = "100m";
const DEFAULT_SANDBOX_REQUEST_MEMORY = "256Mi";
const DEFAULT_SANDBOX_REQUEST_EPHEMERAL_STORAGE = "16Gi";
const DEFAULT_NODE_FS_EVICTION_RESERVE = "24Gi";
const DEFAULT_SANDBOX_NAMESPACE = "openshell";

type NodeStorageStats = {
	availableBytes: number | null;
	capacityBytes: number | null;
};

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

export function parseCpuMilli(value: unknown): number | null {
	if (typeof value === "number")
		return Number.isFinite(value) ? Math.ceil(value * 1000) : null;
	if (typeof value !== "string" || !value.trim()) return null;
	const raw = value.trim();
	if (raw.endsWith("m")) {
		const parsed = Number(raw.slice(0, -1));
		return Number.isFinite(parsed) ? Math.ceil(parsed) : null;
	}
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? Math.ceil(parsed * 1000) : null;
}

export function parseMemoryBytes(value: unknown): number | null {
	if (typeof value === "number")
		return Number.isFinite(value) ? Math.ceil(value) : null;
	if (typeof value !== "string" || !value.trim()) return null;
	const match = value
		.trim()
		.match(/^([0-9]+(?:\.[0-9]+)?)([KMGTPE]i?|[kMGTPE])?$/);
	if (!match) return null;
	const parsed = Number(match[1]);
	if (!Number.isFinite(parsed)) return null;
	const suffix = match[2] ?? "";
	const binary: Record<string, number> = {
		Ki: 1024,
		Mi: 1024 ** 2,
		Gi: 1024 ** 3,
		Ti: 1024 ** 4,
		Pi: 1024 ** 5,
		Ei: 1024 ** 6,
	};
	const decimal: Record<string, number> = {
		k: 1000,
		K: 1000,
		M: 1000 ** 2,
		G: 1000 ** 3,
		T: 1000 ** 4,
		P: 1000 ** 5,
		E: 1000 ** 6,
	};
	const multiplier = binary[suffix] ?? decimal[suffix] ?? 1;
	return Math.ceil(parsed * multiplier);
}

function containerRequests(container: KubeContainerSpec | undefined) {
	const requests = container?.resources?.requests ?? {};
	return {
		cpuMilli: parseCpuMilli(requests.cpu) ?? 0,
		memoryBytes: parseMemoryBytes(requests.memory) ?? 0,
		ephemeralStorageBytes: parseMemoryBytes(requests["ephemeral-storage"]) ?? 0,
	};
}

function addRequests(
	left: BenchmarkSandboxResourceProfile,
	right: BenchmarkSandboxResourceProfile,
) {
	left.cpuMilli += right.cpuMilli;
	left.memoryBytes += right.memoryBytes;
	left.ephemeralStorageBytes += right.ephemeralStorageBytes;
	return left;
}

function maxRequests(
	left: BenchmarkSandboxResourceProfile,
	right: BenchmarkSandboxResourceProfile,
): BenchmarkSandboxResourceProfile {
	return {
		cpuMilli: Math.max(left.cpuMilli, right.cpuMilli),
		memoryBytes: Math.max(left.memoryBytes, right.memoryBytes),
		ephemeralStorageBytes: Math.max(
			left.ephemeralStorageBytes,
			right.ephemeralStorageBytes,
		),
	};
}

function podRequests(
	pod: KubePod,
	fallbackForSwebench?: BenchmarkSandboxResourceProfile,
	namespace = DEFAULT_SANDBOX_NAMESPACE,
): BenchmarkSandboxResourceProfile {
	let regular = { cpuMilli: 0, memoryBytes: 0, ephemeralStorageBytes: 0 };
	for (const container of pod.spec?.containers ?? []) {
		regular = addRequests(regular, containerRequests(container));
	}
	let initMax = { cpuMilli: 0, memoryBytes: 0, ephemeralStorageBytes: 0 };
	for (const container of pod.spec?.initContainers ?? []) {
		initMax = maxRequests(initMax, containerRequests(container));
	}
	const request = maxRequests(regular, initMax);
	if (
		fallbackForSwebench &&
		isSwebenchSandboxPod(pod, namespace) &&
		request.cpuMilli === 0 &&
		request.memoryBytes === 0 &&
		request.ephemeralStorageBytes === 0
	) {
		return { ...fallbackForSwebench };
	}
	return request;
}

function hasNodeCondition(
	node: KubeNode,
	type: string,
	status = "True",
): boolean {
	return (node.status?.conditions ?? []).some(
		(condition) => condition.type === type && condition.status === status,
	);
}

function isReadyNode(node: KubeNode): boolean {
	return hasNodeCondition(node, "Ready", "True");
}

function hasDiskPressure(node: KubeNode): boolean {
	return hasNodeCondition(node, "DiskPressure", "True");
}

function isWorkerNode(node: KubeNode): boolean {
	const labels = node.metadata?.labels ?? {};
	if ("node-role.kubernetes.io/worker" in labels) return true;
	return !(
		"node-role.kubernetes.io/control-plane" in labels ||
		"node-role.kubernetes.io/master" in labels
	);
}

function hasBlockingTaint(node: KubeNode): boolean {
	return (node.spec?.taints ?? []).some(
		(taint) => taint.effect === "NoSchedule" || taint.effect === "NoExecute",
	);
}

function schedulableWorkerNodes(nodes: KubeNode[]): KubeNode[] {
	return nodes.filter(
		(node) =>
			!!node.metadata?.name &&
			!node.spec?.unschedulable &&
			isReadyNode(node) &&
			isWorkerNode(node) &&
			!hasBlockingTaint(node) &&
			!hasDiskPressure(node),
	);
}

function isTerminalPod(pod: KubePod): boolean {
	return pod.status?.phase === "Succeeded" || pod.status?.phase === "Failed";
}

function isSwebenchSandboxPod(pod: KubePod, namespace: string): boolean {
	const labels = pod.metadata?.labels ?? {};
	const hasSwebenchWorkloadLabel =
		labels["agents.x-k8s.io/workload"] === "swebench";
	if (hasSwebenchWorkloadLabel) return true;
	const hasHostBenchmarkExecutionLabels =
		labels.app === "sandbox-execution-worker" &&
		typeof labels["benchmark-run-id"] === "string" &&
		typeof labels["sandbox-execution-class"] === "string";
	if (hasHostBenchmarkExecutionLabels) return true;
	const name = pod.metadata?.name ?? "";
	return pod.metadata?.namespace === namespace && /^swebench[-_]/.test(name);
}

function sandboxResourceProfileFromEnv(): BenchmarkSandboxResourceProfile {
	return {
		cpuMilli:
			parseCpuMilli(process.env.BENCHMARK_SANDBOX_REQUEST_CPU) ??
			parseCpuMilli(DEFAULT_SANDBOX_REQUEST_CPU)!,
		memoryBytes:
			parseMemoryBytes(process.env.BENCHMARK_SANDBOX_REQUEST_MEMORY) ??
			parseMemoryBytes(DEFAULT_SANDBOX_REQUEST_MEMORY)!,
		ephemeralStorageBytes:
			parseMemoryBytes(
				process.env.BENCHMARK_SANDBOX_REQUEST_EPHEMERAL_STORAGE,
			) ?? parseMemoryBytes(DEFAULT_SANDBOX_REQUEST_EPHEMERAL_STORAGE)!,
	};
}

function addResourceProfiles(
	left: BenchmarkSandboxResourceProfile,
	right: BenchmarkSandboxResourceProfile,
): BenchmarkSandboxResourceProfile {
	return {
		cpuMilli: left.cpuMilli + right.cpuMilli,
		memoryBytes: left.memoryBytes + right.memoryBytes,
		ephemeralStorageBytes:
			left.ephemeralStorageBytes + right.ephemeralStorageBytes,
	};
}

function executionClassConfigFromEnv(
	preferAgentHostClass = false,
): Record<string, unknown> | null {
	const raw = process.env.SANDBOX_EXECUTION_CLASSES_JSON;
	if (!raw?.trim()) return null;
	const classNames = preferAgentHostClass
		? [
				process.env.BENCHMARK_AGENT_WORKFLOW_HOST_EXECUTION_CLASS,
				process.env.BENCHMARK_EXECUTION_CLASS,
				process.env.AGENT_WORKFLOW_HOST_EXECUTION_CLASS,
			]
		: [
				process.env.BENCHMARK_EXECUTION_CLASS,
				process.env.BENCHMARK_AGENT_WORKFLOW_HOST_EXECUTION_CLASS,
				process.env.AGENT_WORKFLOW_HOST_EXECUTION_CLASS,
			];
	const executionClass =
		classNames
			.map((value) => value?.trim())
			.find((value): value is string => !!value) ?? null;
	if (!executionClass) return null;
	try {
		const parsed = JSON.parse(raw) as unknown;
		const classes = recordValue(parsed);
		return recordValue(classes?.[executionClass]);
	} catch {
		return null;
	}
}

function agentHostResourceProfileFromEnv():
	| BenchmarkSandboxResourceProfile
	| null {
	if (!isKueueExecutionBackend(process.env.BENCHMARK_EXECUTION_BACKEND)) {
		return null;
	}
	const config = executionClassConfigFromEnv(true);
	if (!config) return null;
	const cpuMilli = parseCpuMilli(config.agentHostCpu);
	const memoryBytes = parseMemoryBytes(config.agentHostMemory);
	const ephemeralStorageBytes = parseMemoryBytes(
		config.agentHostEphemeralStorage,
	);
	if (
		cpuMilli == null &&
		memoryBytes == null &&
		ephemeralStorageBytes == null
	) {
		return null;
	}
	return {
		cpuMilli: cpuMilli ?? 0,
		memoryBytes: memoryBytes ?? 0,
		ephemeralStorageBytes: ephemeralStorageBytes ?? 0,
	};
}

function executionWorkerResourceProfileFromEnv():
	| BenchmarkSandboxResourceProfile
	| null {
	if (!isKueueExecutionBackend(process.env.BENCHMARK_EXECUTION_BACKEND)) {
		return null;
	}
	const config = executionClassConfigFromEnv(false);
	if (!config) return null;
	const cpuMilli = parseCpuMilli(config.cpu);
	const memoryBytes = parseMemoryBytes(config.memory);
	const ephemeralStorageBytes = parseMemoryBytes(config.ephemeralStorage);
	if (
		cpuMilli == null &&
		memoryBytes == null &&
		ephemeralStorageBytes == null
	) {
		return null;
	}
	return {
		cpuMilli: cpuMilli ?? 0,
		memoryBytes: memoryBytes ?? 0,
		ephemeralStorageBytes: ephemeralStorageBytes ?? 0,
	};
}

function kueueInstanceResourceProfileFromEnv(
	sandboxRequest: BenchmarkSandboxResourceProfile,
): BenchmarkSandboxResourceProfile | null {
	const agentHostRequest = agentHostResourceProfileFromEnv();
	if (!agentHostRequest) return null;
	const executionWorkerRequest = executionWorkerResourceProfileFromEnv();
	return addResourceProfiles(
		addResourceProfiles(sandboxRequest, agentHostRequest),
		executionWorkerRequest ?? {
			cpuMilli: 0,
			memoryBytes: 0,
			ephemeralStorageBytes: 0,
		},
	);
}

export function kueueInstancePodCountFromEnv(
	instanceRequest: BenchmarkSandboxResourceProfile | null,
): number | null {
	if (!instanceRequest) return null;
	const configured = positiveInt(process.env.BENCHMARK_KUEUE_INSTANCE_POD_COUNT);
	if (configured) return configured;
	const config = executionClassConfigFromEnv(true);
	const agentHostImage =
		typeof config?.agentHostImage === "string"
			? config.agentHostImage.trim()
			: "";
	return agentHostImage ? 2 : 1;
}

function nodeFsEvictionReserveBytes(): number {
	return (
		parseMemoryBytes(process.env.BENCHMARK_SANDBOX_NODE_FS_EVICTION_RESERVE) ??
		parseMemoryBytes(DEFAULT_NODE_FS_EVICTION_RESERVE)!
	);
}

function finiteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const child = (value as Record<string, unknown>)[key];
	return child && typeof child === "object" && !Array.isArray(child)
		? (child as Record<string, unknown>)
		: null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function extractNodeStorageStats(value: unknown): NodeStorageStats | null {
	const root =
		value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	if (!root) return null;
	const node = nestedRecord(root, "node");
	const runtime = node ? nestedRecord(node, "runtime") : null;
	const candidates = [
		node ? nestedRecord(node, "fs") : null,
		runtime ? nestedRecord(runtime, "imageFs") : null,
		runtime ? nestedRecord(runtime, "containerFs") : null,
	].filter((entry): entry is Record<string, unknown> => !!entry);
	const availableValues = candidates
		.map((entry) => finiteNumber(entry.availableBytes))
		.filter((entry): entry is number => entry !== null);
	if (availableValues.length === 0) return null;
	const capacityValues = candidates
		.map((entry) => finiteNumber(entry.capacityBytes))
		.filter((entry): entry is number => entry !== null);
	return {
		availableBytes: Math.min(...availableValues),
		capacityBytes: capacityValues.length ? Math.min(...capacityValues) : null,
	};
}

async function loadNodeStorageStats(
	nodeNames: string[],
): Promise<Map<string, NodeStorageStats>> {
	const entries = await Promise.all(
		nodeNames.map(async (nodeName) => {
			try {
				const res = await kubeApiFetch(
					`/api/v1/nodes/${encodeURIComponent(nodeName)}/proxy/stats/summary`,
					{ retries: 0 },
				);
				if (!res.ok) return null;
				const stats = extractNodeStorageStats(await res.json().catch(() => null));
				return stats ? ([nodeName, stats] as const) : null;
			} catch {
				return null;
			}
		}),
	);
	return new Map(
		entries.filter((entry): entry is [string, NodeStorageStats] => !!entry),
	);
}

function namespaceFromEnv(): string {
	return (
		process.env.BENCHMARK_SANDBOX_CAPACITY_NAMESPACE?.trim() ||
		process.env.OPENSHELL_NAMESPACE?.trim() ||
		DEFAULT_SANDBOX_NAMESPACE
	);
}

function isKueueExecutionBackend(value: unknown): boolean {
	if (typeof value !== "string" || !value.trim()) return false;
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/_/g, "-");
	return (
		normalized === "dapr-kueue" ||
		normalized === "kueue-dapr" ||
		normalized === "kueue-agent-hosts" ||
		normalized === "agent-host-kueue" ||
		normalized === "host" ||
		normalized === "host-execution" ||
		normalized === "host-execution-plane"
	);
}

function kueueClusterQueueNameFromEnv(): string | null {
	if (!isKueueExecutionBackend(process.env.BENCHMARK_EXECUTION_BACKEND)) {
		return null;
	}
	return (
		process.env.BENCHMARK_KUEUE_CLUSTER_QUEUE?.trim() ||
		process.env.BENCHMARK_AGENT_WORKFLOW_HOST_EXECUTION_CLASS?.trim() ||
		process.env.BENCHMARK_EXECUTION_CLASS?.trim() ||
		process.env.AGENT_WORKFLOW_HOST_EXECUTION_CLASS?.trim() ||
		null
	);
}

function resourceQuantity(
	resourceName: string,
	value: unknown,
): number | null {
	if (resourceName === "cpu") return parseCpuMilli(value);
	if (resourceName === "memory" || resourceName === "ephemeral-storage") {
		return parseMemoryBytes(value);
	}
	if (resourceName === "pods") return nonNegativeInt(value);
	return null;
}

function resourceMapFromEntries(
	entries: unknown,
): Map<string, number> {
	const resources = new Map<string, number>();
	if (!Array.isArray(entries)) return resources;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const record = entry as Record<string, unknown>;
		const name = typeof record.name === "string" ? record.name : null;
		if (!name) continue;
		const value = resourceQuantity(name, record.nominalQuota ?? record.total);
		if (value == null) continue;
		resources.set(name, (resources.get(name) ?? 0) + value);
	}
	return resources;
}

function finiteCapacityMin(values: Array<number | null>): number | null {
	const candidates = values.filter(
		(value): value is number => typeof value === "number" && Number.isFinite(value),
	);
	return candidates.length > 0 ? Math.min(...candidates) : null;
}

function clusterQueueActiveCondition(status: Record<string, unknown> | null): {
	active: boolean | null;
	reason: string | null;
	message: string | null;
} {
	const conditions = Array.isArray(status?.conditions) ? status.conditions : [];
	for (const condition of conditions) {
		if (!condition || typeof condition !== "object" || Array.isArray(condition)) {
			continue;
		}
		const record = condition as Record<string, unknown>;
		if (record.type !== "Active") continue;
		const rawStatus = typeof record.status === "string" ? record.status : "";
		return {
			active: rawStatus === "True" ? true : rawStatus === "False" ? false : null,
			reason: typeof record.reason === "string" ? record.reason : null,
			message: typeof record.message === "string" ? record.message : null,
		};
	}
	return { active: null, reason: null, message: null };
}

export function kueueCapacityFromClusterQueue(
	clusterQueue: unknown,
	sandboxRequest: BenchmarkSandboxResourceProfile,
	options?: {
		instanceRequest?: BenchmarkSandboxResourceProfile | null;
		instancePodCount?: number | null;
	},
): BenchmarkKueueCapacitySnapshot | null {
	if (!clusterQueue || typeof clusterQueue !== "object" || Array.isArray(clusterQueue)) {
		return null;
	}
	const root = clusterQueue as Record<string, unknown>;
	const metadata = recordValue(root.metadata);
	const clusterQueueName =
		typeof metadata?.name === "string" ? metadata.name : "benchmark-fast";
	const spec = recordValue(root.spec);
	const status = recordValue(root.status);
	const activeCondition = clusterQueueActiveCondition(status);
	const quotas = new Map<string, number>();
	const borrowingLimits = new Map<string, number>();
	const resourceGroups: unknown[] = Array.isArray(spec?.resourceGroups)
		? spec.resourceGroups
		: [];
	for (const group of resourceGroups) {
		const groupRecord = recordValue(group);
		const flavors: unknown[] = Array.isArray(groupRecord?.flavors)
			? groupRecord.flavors
			: [];
		for (const flavor of flavors) {
			const flavorRecord = recordValue(flavor);
			const resources = resourceMapFromEntries(flavorRecord?.resources);
			for (const [name, value] of resources) {
				quotas.set(name, (quotas.get(name) ?? 0) + value);
			}
			if (Array.isArray(flavorRecord?.resources)) {
				for (const entry of flavorRecord.resources) {
					const record = recordValue(entry);
					const name = typeof record?.name === "string" ? record.name : null;
					if (!name) continue;
					const value = resourceQuantity(name, record?.borrowingLimit);
					if (value == null) continue;
					borrowingLimits.set(name, (borrowingLimits.get(name) ?? 0) + value);
				}
			}
		}
	}
	const usage = new Map<string, number>();
	const flavorUsage: unknown[] = Array.isArray(status?.flavorsUsage)
		? status.flavorsUsage
		: [];
	for (const flavor of flavorUsage) {
		const flavorRecord = recordValue(flavor);
		const resources = resourceMapFromEntries(flavorRecord?.resources);
		for (const [name, value] of resources) {
			usage.set(name, (usage.get(name) ?? 0) + value);
		}
	}
	function remaining(name: string): number | null {
		const quota = quotas.get(name);
		if (quota == null) return null;
		return Math.max(0, quota - (usage.get(name) ?? 0));
	}
	function borrowRemaining(name: string): number | null {
		const quota = quotas.get(name);
		if (quota == null) return null;
		return Math.max(
			0,
			quota + (borrowingLimits.get(name) ?? 0) - (usage.get(name) ?? 0),
		);
	}
	const availableCpuMilli = remaining("cpu");
	const availableMemoryBytes = remaining("memory");
	const availableEphemeralStorageBytes = remaining("ephemeral-storage");
	const availablePods = remaining("pods");
	const borrowAvailableCpuMilli = borrowRemaining("cpu");
	const borrowAvailableMemoryBytes = borrowRemaining("memory");
	const borrowAvailableEphemeralStorageBytes = borrowRemaining("ephemeral-storage");
	const borrowAvailablePods = borrowRemaining("pods");
	const cpuLimitedCapacity =
		availableCpuMilli == null
			? null
			: Math.floor(availableCpuMilli / sandboxRequest.cpuMilli);
	const memoryLimitedCapacity =
		availableMemoryBytes == null
			? null
			: Math.floor(availableMemoryBytes / sandboxRequest.memoryBytes);
	const ephemeralStorageLimitedCapacity =
		availableEphemeralStorageBytes == null ||
		sandboxRequest.ephemeralStorageBytes <= 0
			? null
			: Math.floor(
					availableEphemeralStorageBytes /
						sandboxRequest.ephemeralStorageBytes,
				);
	const podLimitedCapacity = availablePods == null ? null : availablePods;
	const availableSandboxSlots = finiteCapacityMin([
		cpuLimitedCapacity,
		memoryLimitedCapacity,
		ephemeralStorageLimitedCapacity,
		podLimitedCapacity,
	]);
	if (availableSandboxSlots == null) return null;
	const borrowAvailableSandboxSlots = finiteCapacityMin([
		borrowAvailableCpuMilli == null
			? null
			: Math.floor(borrowAvailableCpuMilli / sandboxRequest.cpuMilli),
		borrowAvailableMemoryBytes == null
			? null
			: Math.floor(borrowAvailableMemoryBytes / sandboxRequest.memoryBytes),
		borrowAvailableEphemeralStorageBytes == null ||
		sandboxRequest.ephemeralStorageBytes <= 0
			? null
			: Math.floor(
					borrowAvailableEphemeralStorageBytes /
						sandboxRequest.ephemeralStorageBytes,
				),
		borrowAvailablePods,
	]);
	const instanceRequest = options?.instanceRequest ?? null;
	const instancePodCount = positiveInt(options?.instancePodCount) ?? 2;
	const instanceCpuLimitedCapacity =
		availableCpuMilli == null || !instanceRequest
			? null
			: Math.floor(availableCpuMilli / Math.max(1, instanceRequest.cpuMilli));
	const instanceMemoryLimitedCapacity =
		availableMemoryBytes == null || !instanceRequest
			? null
			: Math.floor(
					availableMemoryBytes / Math.max(1, instanceRequest.memoryBytes),
				);
	const instanceEphemeralStorageLimitedCapacity =
		availableEphemeralStorageBytes == null ||
		!instanceRequest ||
		instanceRequest.ephemeralStorageBytes <= 0
			? null
			: Math.floor(
					availableEphemeralStorageBytes /
						instanceRequest.ephemeralStorageBytes,
				);
	const instancePodLimitedCapacity =
		availablePods == null || !instanceRequest
			? null
			: Math.floor(availablePods / instancePodCount);
	const availableInstanceSlots = instanceRequest
		? finiteCapacityMin([
				instanceCpuLimitedCapacity,
				instanceMemoryLimitedCapacity,
				instanceEphemeralStorageLimitedCapacity,
				instancePodLimitedCapacity,
			])
		: null;
	const borrowAvailableInstanceSlots = instanceRequest
		? finiteCapacityMin([
				borrowAvailableCpuMilli == null
					? null
					: Math.floor(
							borrowAvailableCpuMilli / Math.max(1, instanceRequest.cpuMilli),
						),
				borrowAvailableMemoryBytes == null
					? null
					: Math.floor(
							borrowAvailableMemoryBytes /
								Math.max(1, instanceRequest.memoryBytes),
						),
				borrowAvailableEphemeralStorageBytes == null ||
				instanceRequest.ephemeralStorageBytes <= 0
					? null
					: Math.floor(
							borrowAvailableEphemeralStorageBytes /
								instanceRequest.ephemeralStorageBytes,
						),
				borrowAvailablePods == null
					? null
					: Math.floor(borrowAvailablePods / instancePodCount),
			])
		: null;
	return {
		clusterQueueName,
		clusterQueueActive: activeCondition.active,
		clusterQueueReason: activeCondition.reason,
		clusterQueueMessage: activeCondition.message,
		availableSandboxSlots,
		cpuLimitedCapacity,
		memoryLimitedCapacity,
		ephemeralStorageLimitedCapacity,
		podLimitedCapacity,
		availableCpuMilli,
			availableMemoryBytes,
			availableEphemeralStorageBytes,
			availablePods,
			borrowAvailableSandboxSlots,
		instanceRequestCpuMilli: instanceRequest?.cpuMilli ?? null,
		instanceRequestMemoryBytes: instanceRequest?.memoryBytes ?? null,
		instanceRequestEphemeralStorageBytes:
			instanceRequest?.ephemeralStorageBytes ?? null,
			instancePodCount: instanceRequest ? instancePodCount : null,
			availableInstanceSlots,
			borrowAvailableInstanceSlots,
		instanceCpuLimitedCapacity,
		instanceMemoryLimitedCapacity,
		instanceEphemeralStorageLimitedCapacity,
		instancePodLimitedCapacity,
	};
}

async function loadKueueClusterQueueCapacity(
	clusterQueueName: string | null,
	sandboxRequest: BenchmarkSandboxResourceProfile,
	instanceRequest: BenchmarkSandboxResourceProfile | null,
	instancePodCount: number | null,
): Promise<BenchmarkKueueCapacitySnapshot | null> {
	if (!clusterQueueName) return null;
	if (
		/^(1|true|yes)$/i.test(
			process.env.BENCHMARK_SANDBOX_KUEUE_CAPACITY_DISABLED ?? "",
		)
	) {
		return null;
	}
	for (const version of ["v1beta2", "v1beta1"]) {
		try {
			const res = await kubeApiFetch(
				`/apis/kueue.x-k8s.io/${version}/clusterqueues/${encodeURIComponent(clusterQueueName)}`,
				{ retries: 0 },
			);
			if (!res.ok) continue;
			return kueueCapacityFromClusterQueue(await res.json(), sandboxRequest, {
				instanceRequest,
				instancePodCount,
			});
		} catch {
			continue;
		}
	}
	return null;
}

export function estimateSchedulableSandboxCapacity(params: {
	nodes: KubeNode[];
	pods: KubePod[];
	sandboxRequest?: BenchmarkSandboxResourceProfile | null;
	kueueInstanceRequest?: BenchmarkSandboxResourceProfile | null;
	nodeStorageStats?: Map<string, NodeStorageStats> | null;
	kueueCapacity?: BenchmarkKueueCapacitySnapshot | null;
	namespace?: string | null;
	podScope?: "all-namespaces" | "namespace";
	now?: Date;
}): BenchmarkSandboxCapacitySnapshot {
	const namespace = params.namespace?.trim() || DEFAULT_SANDBOX_NAMESPACE;
	const sandboxRequest = params.sandboxRequest ?? {
		cpuMilli: parseCpuMilli(DEFAULT_SANDBOX_REQUEST_CPU)!,
		memoryBytes: parseMemoryBytes(DEFAULT_SANDBOX_REQUEST_MEMORY)!,
		ephemeralStorageBytes: parseMemoryBytes(
			DEFAULT_SANDBOX_REQUEST_EPHEMERAL_STORAGE,
		)!,
	};
	const kueueInstanceRequest = params.kueueInstanceRequest ?? null;
	const diskPressureNodeCount = params.nodes.filter(
		(node) =>
			!!node.metadata?.name &&
			!node.spec?.unschedulable &&
			isWorkerNode(node) &&
			hasDiskPressure(node),
	).length;
	const nodes = schedulableWorkerNodes(params.nodes);
	const nodeNames = new Set(nodes.map((node) => node.metadata!.name!));
	const nodeStorageStats = params.nodeStorageStats ?? null;
	const hasNodeStorageStats = !!nodeStorageStats && nodeStorageStats.size > 0;
	const nodeFsReserveBytes = nodeFsEvictionReserveBytes();
	let allocatableCpuMilli = 0;
	let allocatableMemoryBytes = 0;
	let allocatableEphemeralStorageBytes = 0;
	let nodeFsAvailableBytes: number | null = hasNodeStorageStats ? 0 : null;
	let nodeFsCapacityBytes: number | null = hasNodeStorageStats ? 0 : null;
	for (const node of nodes) {
		const nodeName = node.metadata!.name!;
		const allocatable = node.status?.allocatable ?? {};
		allocatableCpuMilli += parseCpuMilli(allocatable.cpu) ?? 0;
		allocatableMemoryBytes += parseMemoryBytes(allocatable.memory) ?? 0;
		allocatableEphemeralStorageBytes +=
			parseMemoryBytes(allocatable["ephemeral-storage"]) ?? 0;
		const storage = nodeStorageStats?.get(nodeName);
		if (storage?.availableBytes !== null && storage?.availableBytes !== undefined) {
			nodeFsAvailableBytes =
				(nodeFsAvailableBytes ?? 0) +
				Math.max(0, storage.availableBytes - nodeFsReserveBytes);
		}
		if (storage?.capacityBytes !== null && storage?.capacityBytes !== undefined) {
			nodeFsCapacityBytes = (nodeFsCapacityBytes ?? 0) + storage.capacityBytes;
		}
	}

	let requestedCpuMilli = 0;
	let requestedMemoryBytes = 0;
	let requestedEphemeralStorageBytes = 0;
	let pendingSwebenchCpuMilli = 0;
	let pendingSwebenchMemoryBytes = 0;
	let pendingSwebenchEphemeralStorageBytes = 0;
	let activeSwebenchPods = 0;
	let pendingSwebenchPods = 0;

	for (const pod of params.pods) {
		if (isTerminalPod(pod)) continue;
		const requests = podRequests(pod, sandboxRequest, namespace);
		const nodeName = pod.spec?.nodeName;
		const isSwebench = isSwebenchSandboxPod(pod, namespace);
		if (nodeName && nodeNames.has(nodeName)) {
			requestedCpuMilli += requests.cpuMilli;
			requestedMemoryBytes += requests.memoryBytes;
			requestedEphemeralStorageBytes += requests.ephemeralStorageBytes;
			if (isSwebench) activeSwebenchPods += 1;
			continue;
		}
		if (isSwebench) {
			pendingSwebenchPods += 1;
			pendingSwebenchCpuMilli += requests.cpuMilli;
			pendingSwebenchMemoryBytes += requests.memoryBytes;
			pendingSwebenchEphemeralStorageBytes += requests.ephemeralStorageBytes;
		}
	}

	const availableCpuMilli = Math.max(
		0,
		allocatableCpuMilli - requestedCpuMilli - pendingSwebenchCpuMilli,
	);
	const availableMemoryBytes = Math.max(
		0,
		allocatableMemoryBytes - requestedMemoryBytes - pendingSwebenchMemoryBytes,
	);
	const availableEphemeralStorageBytes = Math.max(
		0,
		allocatableEphemeralStorageBytes -
			requestedEphemeralStorageBytes -
			pendingSwebenchEphemeralStorageBytes,
	);
	const cpuLimitedCapacity = Math.max(
		0,
		Math.floor(availableCpuMilli / sandboxRequest.cpuMilli),
	);
	const memoryLimitedCapacity = Math.max(
		0,
		Math.floor(availableMemoryBytes / sandboxRequest.memoryBytes),
	);
	const ephemeralStorageLimitedCapacity =
		allocatableEphemeralStorageBytes > 0 &&
		sandboxRequest.ephemeralStorageBytes > 0
			? Math.max(
					0,
					Math.floor(
						availableEphemeralStorageBytes /
							sandboxRequest.ephemeralStorageBytes,
					),
				)
			: null;
	const nodeFsLimitedCapacity =
		nodeFsAvailableBytes !== null && sandboxRequest.ephemeralStorageBytes > 0
			? Math.max(
					0,
					Math.floor(
						Math.max(0, nodeFsAvailableBytes - pendingSwebenchEphemeralStorageBytes) /
							sandboxRequest.ephemeralStorageBytes,
					),
				)
			: null;
	const kueueInstanceCpuLimitedCapacity = kueueInstanceRequest
		? Math.max(
				0,
				Math.floor(
					availableCpuMilli / Math.max(1, kueueInstanceRequest.cpuMilli),
				),
			)
		: null;
	const kueueInstanceMemoryLimitedCapacity = kueueInstanceRequest
		? Math.max(
				0,
				Math.floor(
					availableMemoryBytes /
						Math.max(1, kueueInstanceRequest.memoryBytes),
				),
			)
		: null;
	const kueueInstanceEphemeralStorageLimitedCapacity =
		kueueInstanceRequest && kueueInstanceRequest.ephemeralStorageBytes > 0
			? Math.max(
					0,
					Math.floor(
						availableEphemeralStorageBytes /
							kueueInstanceRequest.ephemeralStorageBytes,
					),
				)
			: null;
	const rawAvailableSandboxSlots = Math.min(
		cpuLimitedCapacity,
		memoryLimitedCapacity,
		ephemeralStorageLimitedCapacity ?? Number.POSITIVE_INFINITY,
		nodeFsLimitedCapacity ?? Number.POSITIVE_INFINITY,
	);
	const kueueCapacity = params.kueueCapacity ?? null;
	const availableSandboxSlots = Math.min(
		rawAvailableSandboxSlots,
		kueueCapacity?.availableSandboxSlots ?? Number.POSITIVE_INFINITY,
	);
	const schedulableKueueInstanceCapacity =
		kueueCapacity?.availableInstanceSlots == null
			? null
			: Math.min(
					availableSandboxSlots,
					kueueCapacity?.availableInstanceSlots ?? Number.POSITIVE_INFINITY,
				);
	const currentSwebenchPods = activeSwebenchPods + pendingSwebenchPods;
	const totalSchedulableSandboxCapacity =
		currentSwebenchPods + availableSandboxSlots;

	return {
		sampledAt: (params.now ?? new Date()).toISOString(),
		namespace,
		podScope: params.podScope ?? "all-namespaces",
		nodeCount: nodes.length,
		allocatableCpuMilli,
		allocatableMemoryBytes,
		allocatableEphemeralStorageBytes,
		requestedCpuMilli,
		requestedMemoryBytes,
		requestedEphemeralStorageBytes,
		pendingSwebenchCpuMilli,
		pendingSwebenchMemoryBytes,
		pendingSwebenchEphemeralStorageBytes,
		availableCpuMilli,
		availableMemoryBytes,
		availableEphemeralStorageBytes,
		sandboxRequestCpuMilli: sandboxRequest.cpuMilli,
		sandboxRequestMemoryBytes: sandboxRequest.memoryBytes,
		sandboxRequestEphemeralStorageBytes: sandboxRequest.ephemeralStorageBytes,
		availableSandboxSlots,
		totalSchedulableSandboxCapacity,
		schedulableSandboxCapacity: availableSandboxSlots,
		cpuLimitedCapacity,
		memoryLimitedCapacity,
		ephemeralStorageLimitedCapacity,
		nodeFsAvailableBytes,
		nodeFsCapacityBytes,
		nodeFsEvictionReserveBytes: nodeFsReserveBytes,
		nodeFsLimitedCapacity,
		kueueClusterQueueName: kueueCapacity?.clusterQueueName ?? null,
		kueueClusterQueueActive: kueueCapacity?.clusterQueueActive ?? null,
		kueueClusterQueueReason: kueueCapacity?.clusterQueueReason ?? null,
		kueueClusterQueueMessage: kueueCapacity?.clusterQueueMessage ?? null,
		kueueAvailableSandboxSlots: kueueCapacity?.availableSandboxSlots ?? null,
		kueueBorrowAvailableSandboxSlots:
			kueueCapacity?.borrowAvailableSandboxSlots ?? null,
		kueueCpuLimitedCapacity: kueueCapacity?.cpuLimitedCapacity ?? null,
		kueueMemoryLimitedCapacity: kueueCapacity?.memoryLimitedCapacity ?? null,
		kueueEphemeralStorageLimitedCapacity:
			kueueCapacity?.ephemeralStorageLimitedCapacity ?? null,
		kueuePodLimitedCapacity: kueueCapacity?.podLimitedCapacity ?? null,
		kueueInstanceRequestCpuMilli:
			kueueCapacity?.instanceRequestCpuMilli ??
			kueueInstanceRequest?.cpuMilli ??
			null,
		kueueInstanceRequestMemoryBytes:
			kueueCapacity?.instanceRequestMemoryBytes ??
			kueueInstanceRequest?.memoryBytes ??
			null,
		kueueInstanceRequestEphemeralStorageBytes:
			kueueCapacity?.instanceRequestEphemeralStorageBytes ??
			kueueInstanceRequest?.ephemeralStorageBytes ??
			null,
		kueueInstancePodCount: kueueCapacity?.instancePodCount ?? null,
		kueueAvailableInstanceSlots: kueueCapacity?.availableInstanceSlots ?? null,
		kueueBorrowAvailableInstanceSlots:
			kueueCapacity?.borrowAvailableInstanceSlots ?? null,
		kueueInstanceCpuLimitedCapacity:
			kueueCapacity?.instanceCpuLimitedCapacity ??
			kueueInstanceCpuLimitedCapacity,
		kueueInstanceMemoryLimitedCapacity:
			kueueCapacity?.instanceMemoryLimitedCapacity ??
			kueueInstanceMemoryLimitedCapacity,
		kueueInstanceEphemeralStorageLimitedCapacity:
			kueueCapacity?.instanceEphemeralStorageLimitedCapacity ??
			kueueInstanceEphemeralStorageLimitedCapacity,
		kueueInstancePodLimitedCapacity:
			kueueCapacity?.instancePodLimitedCapacity ?? null,
		schedulableKueueInstanceCapacity,
		activeSwebenchPods,
		pendingSwebenchPods,
		diskPressureNodeCount,
	};
}

export async function loadSchedulableSandboxCapacitySnapshot(): Promise<BenchmarkSandboxCapacitySnapshot | null> {
	if (
		/^(1|true|yes)$/i.test(
			process.env.BENCHMARK_SANDBOX_CAPACITY_DISABLED ?? "",
		)
	) {
		return null;
	}
	const namespace = namespaceFromEnv();
	const sandboxRequest = sandboxResourceProfileFromEnv();
	const kueueInstanceRequest =
		kueueInstanceResourceProfileFromEnv(sandboxRequest);
	const kueueInstancePodCount = kueueInstancePodCountFromEnv(kueueInstanceRequest);
	try {
		const kueueCapacity = await loadKueueClusterQueueCapacity(
			kueueClusterQueueNameFromEnv(),
			sandboxRequest,
			kueueInstanceRequest,
			kueueInstancePodCount,
		);
		const nodes = await listNodes();
		const nodeNames = schedulableWorkerNodes(nodes)
			.map((node) => node.metadata?.name)
			.filter((name): name is string => !!name);
		const nodeStorageStats = await loadNodeStorageStats(nodeNames);
		let pods: KubePod[];
		let podScope: "all-namespaces" | "namespace" = "all-namespaces";
		try {
			pods = await listPodsAllNamespaces();
		} catch {
			pods = await listPods(namespace);
			podScope = "namespace";
		}
		return estimateSchedulableSandboxCapacity({
			nodes,
			pods,
			sandboxRequest,
			kueueInstanceRequest,
			nodeStorageStats,
			kueueCapacity,
			namespace,
			podScope,
		});
	} catch (err) {
		return {
			sampledAt: new Date().toISOString(),
			namespace,
			podScope: "namespace",
			nodeCount: 0,
			allocatableCpuMilli: 0,
			allocatableMemoryBytes: 0,
			allocatableEphemeralStorageBytes: 0,
			requestedCpuMilli: 0,
			requestedMemoryBytes: 0,
			requestedEphemeralStorageBytes: 0,
			pendingSwebenchCpuMilli: 0,
			pendingSwebenchMemoryBytes: 0,
			pendingSwebenchEphemeralStorageBytes: 0,
			availableCpuMilli: 0,
			availableMemoryBytes: 0,
			availableEphemeralStorageBytes: 0,
			sandboxRequestCpuMilli: sandboxRequest.cpuMilli,
			sandboxRequestMemoryBytes: sandboxRequest.memoryBytes,
			sandboxRequestEphemeralStorageBytes: sandboxRequest.ephemeralStorageBytes,
			availableSandboxSlots: 0,
			totalSchedulableSandboxCapacity: 0,
			schedulableSandboxCapacity: 0,
			cpuLimitedCapacity: 0,
			memoryLimitedCapacity: 0,
			ephemeralStorageLimitedCapacity: 0,
			nodeFsAvailableBytes: null,
			nodeFsCapacityBytes: null,
			nodeFsEvictionReserveBytes: nodeFsEvictionReserveBytes(),
			nodeFsLimitedCapacity: null,
			kueueClusterQueueName: null,
			kueueClusterQueueActive: null,
			kueueClusterQueueReason: null,
			kueueClusterQueueMessage: null,
			kueueAvailableSandboxSlots: null,
			kueueBorrowAvailableSandboxSlots: null,
			kueueCpuLimitedCapacity: null,
			kueueMemoryLimitedCapacity: null,
			kueueEphemeralStorageLimitedCapacity: null,
			kueuePodLimitedCapacity: null,
			kueueInstanceRequestCpuMilli: kueueInstanceRequest?.cpuMilli ?? null,
			kueueInstanceRequestMemoryBytes:
				kueueInstanceRequest?.memoryBytes ?? null,
			kueueInstanceRequestEphemeralStorageBytes:
				kueueInstanceRequest?.ephemeralStorageBytes ?? null,
			kueueInstancePodCount,
			kueueAvailableInstanceSlots: null,
			kueueBorrowAvailableInstanceSlots: null,
			kueueInstanceCpuLimitedCapacity: null,
			kueueInstanceMemoryLimitedCapacity: null,
			kueueInstanceEphemeralStorageLimitedCapacity: null,
			kueueInstancePodLimitedCapacity: null,
			schedulableKueueInstanceCapacity: null,
			activeSwebenchPods: 0,
			pendingSwebenchPods: 0,
			diskPressureNodeCount: 0,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export function sandboxCapacityNumber(
	value: BenchmarkSandboxCapacitySnapshot | null | undefined,
	key: keyof BenchmarkSandboxCapacitySnapshot,
): number | null {
	return positiveInt(value?.[key]);
}

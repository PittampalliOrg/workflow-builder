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
	activeSwebenchPods: number;
	pendingSwebenchPods: number;
	diskPressureNodeCount: number;
	error?: string;
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
	const hasSwebenchWorkloadLabel = Object.entries(labels).some(([key, value]) => {
		const combined = `${key}=${value}`.toLowerCase();
		return (
			combined.includes("swebench") ||
			combined.includes("workflow-builder:swebench")
		);
	});
	if (hasSwebenchWorkloadLabel) return true;
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

export function estimateSchedulableSandboxCapacity(params: {
	nodes: KubeNode[];
	pods: KubePod[];
	sandboxRequest?: BenchmarkSandboxResourceProfile | null;
	nodeStorageStats?: Map<string, NodeStorageStats> | null;
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
	const availableSandboxSlots = Math.min(
		cpuLimitedCapacity,
		memoryLimitedCapacity,
		ephemeralStorageLimitedCapacity ?? Number.POSITIVE_INFINITY,
		nodeFsLimitedCapacity ?? Number.POSITIVE_INFINITY,
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
	try {
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
			nodeStorageStats,
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

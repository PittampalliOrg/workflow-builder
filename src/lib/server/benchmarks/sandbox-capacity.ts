import {
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
	requestedCpuMilli: number;
	requestedMemoryBytes: number;
	pendingSwebenchCpuMilli: number;
	pendingSwebenchMemoryBytes: number;
	availableCpuMilli: number;
	availableMemoryBytes: number;
	sandboxRequestCpuMilli: number;
	sandboxRequestMemoryBytes: number;
	availableSandboxSlots: number;
	totalSchedulableSandboxCapacity: number;
	schedulableSandboxCapacity: number;
	cpuLimitedCapacity: number;
	memoryLimitedCapacity: number;
	activeSwebenchPods: number;
	pendingSwebenchPods: number;
	error?: string;
};

export type BenchmarkSandboxResourceProfile = {
	cpuMilli: number;
	memoryBytes: number;
};

const DEFAULT_SANDBOX_REQUEST_CPU = "100m";
const DEFAULT_SANDBOX_REQUEST_MEMORY = "256Mi";
const DEFAULT_SANDBOX_NAMESPACE = "openshell";

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
	if (typeof value === "number") return Number.isFinite(value) ? Math.ceil(value * 1000) : null;
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
	if (typeof value === "number") return Number.isFinite(value) ? Math.ceil(value) : null;
	if (typeof value !== "string" || !value.trim()) return null;
	const match = value.trim().match(/^([0-9]+(?:\.[0-9]+)?)([KMGTPE]i?|[kMGTPE])?$/);
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
	};
}

function addRequests(
	left: BenchmarkSandboxResourceProfile,
	right: BenchmarkSandboxResourceProfile,
) {
	left.cpuMilli += right.cpuMilli;
	left.memoryBytes += right.memoryBytes;
	return left;
}

function maxRequests(
	left: BenchmarkSandboxResourceProfile,
	right: BenchmarkSandboxResourceProfile,
): BenchmarkSandboxResourceProfile {
	return {
		cpuMilli: Math.max(left.cpuMilli, right.cpuMilli),
		memoryBytes: Math.max(left.memoryBytes, right.memoryBytes),
	};
}

function podRequests(
	pod: KubePod,
	fallbackForSwebench?: BenchmarkSandboxResourceProfile,
): BenchmarkSandboxResourceProfile {
	let regular = { cpuMilli: 0, memoryBytes: 0 };
	for (const container of pod.spec?.containers ?? []) {
		regular = addRequests(regular, containerRequests(container));
	}
	let initMax = { cpuMilli: 0, memoryBytes: 0 };
	for (const container of pod.spec?.initContainers ?? []) {
		initMax = maxRequests(initMax, containerRequests(container));
	}
	const request = maxRequests(regular, initMax);
	if (
		fallbackForSwebench &&
		isSwebenchSandboxPod(pod) &&
		request.cpuMilli === 0 &&
		request.memoryBytes === 0
	) {
		return { ...fallbackForSwebench };
	}
	return request;
}

function isReadyNode(node: KubeNode): boolean {
	return (node.status?.conditions ?? []).some(
		(condition) => condition.type === "Ready" && condition.status === "True",
	);
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
			!hasBlockingTaint(node),
	);
}

function isTerminalPod(pod: KubePod): boolean {
	return pod.status?.phase === "Succeeded" || pod.status?.phase === "Failed";
}

function isSwebenchSandboxPod(pod: KubePod): boolean {
	const name = pod.metadata?.name ?? "";
	if (/^swebench[-_]/.test(name)) return true;
	const labels = pod.metadata?.labels ?? {};
	return Object.entries(labels).some(([key, value]) => {
		const combined = `${key}=${value}`.toLowerCase();
		return combined.includes("swebench") || combined.includes("workflow-builder:swebench");
	});
}

function sandboxResourceProfileFromEnv(): BenchmarkSandboxResourceProfile {
	return {
		cpuMilli:
			parseCpuMilli(process.env.BENCHMARK_SANDBOX_REQUEST_CPU) ??
			parseCpuMilli(DEFAULT_SANDBOX_REQUEST_CPU)!,
		memoryBytes:
			parseMemoryBytes(process.env.BENCHMARK_SANDBOX_REQUEST_MEMORY) ??
			parseMemoryBytes(DEFAULT_SANDBOX_REQUEST_MEMORY)!,
	};
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
	namespace?: string | null;
	podScope?: "all-namespaces" | "namespace";
	now?: Date;
}): BenchmarkSandboxCapacitySnapshot {
	const namespace = params.namespace?.trim() || DEFAULT_SANDBOX_NAMESPACE;
	const sandboxRequest = params.sandboxRequest ?? {
		cpuMilli: parseCpuMilli(DEFAULT_SANDBOX_REQUEST_CPU)!,
		memoryBytes: parseMemoryBytes(DEFAULT_SANDBOX_REQUEST_MEMORY)!,
	};
	const nodes = schedulableWorkerNodes(params.nodes);
	const nodeNames = new Set(nodes.map((node) => node.metadata!.name!));
	let allocatableCpuMilli = 0;
	let allocatableMemoryBytes = 0;
	for (const node of nodes) {
		const allocatable = node.status?.allocatable ?? {};
		allocatableCpuMilli += parseCpuMilli(allocatable.cpu) ?? 0;
		allocatableMemoryBytes += parseMemoryBytes(allocatable.memory) ?? 0;
	}

	let requestedCpuMilli = 0;
	let requestedMemoryBytes = 0;
	let pendingSwebenchCpuMilli = 0;
	let pendingSwebenchMemoryBytes = 0;
	let activeSwebenchPods = 0;
	let pendingSwebenchPods = 0;

	for (const pod of params.pods) {
		if (isTerminalPod(pod)) continue;
		const requests = podRequests(pod, sandboxRequest);
		const nodeName = pod.spec?.nodeName;
		const isSwebench = isSwebenchSandboxPod(pod);
		if (nodeName && nodeNames.has(nodeName)) {
			requestedCpuMilli += requests.cpuMilli;
			requestedMemoryBytes += requests.memoryBytes;
			if (isSwebench) activeSwebenchPods += 1;
			continue;
		}
		if (isSwebench) {
			pendingSwebenchPods += 1;
			pendingSwebenchCpuMilli += requests.cpuMilli;
			pendingSwebenchMemoryBytes += requests.memoryBytes;
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
	const cpuLimitedCapacity = Math.max(
		0,
		Math.floor(availableCpuMilli / sandboxRequest.cpuMilli),
	);
	const memoryLimitedCapacity = Math.max(
		0,
		Math.floor(availableMemoryBytes / sandboxRequest.memoryBytes),
	);
	const availableSandboxSlots = Math.min(cpuLimitedCapacity, memoryLimitedCapacity);
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
		requestedCpuMilli,
		requestedMemoryBytes,
		pendingSwebenchCpuMilli,
		pendingSwebenchMemoryBytes,
		availableCpuMilli,
		availableMemoryBytes,
		sandboxRequestCpuMilli: sandboxRequest.cpuMilli,
		sandboxRequestMemoryBytes: sandboxRequest.memoryBytes,
		availableSandboxSlots,
		totalSchedulableSandboxCapacity,
		schedulableSandboxCapacity: availableSandboxSlots,
		cpuLimitedCapacity,
		memoryLimitedCapacity,
		activeSwebenchPods,
		pendingSwebenchPods,
	};
}

export async function loadSchedulableSandboxCapacitySnapshot(): Promise<
	BenchmarkSandboxCapacitySnapshot | null
> {
	if (/^(1|true|yes)$/i.test(process.env.BENCHMARK_SANDBOX_CAPACITY_DISABLED ?? "")) {
		return null;
	}
	const namespace = namespaceFromEnv();
	const sandboxRequest = sandboxResourceProfileFromEnv();
	try {
		const nodes = await listNodes();
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
			requestedCpuMilli: 0,
			requestedMemoryBytes: 0,
			pendingSwebenchCpuMilli: 0,
			pendingSwebenchMemoryBytes: 0,
			availableCpuMilli: 0,
			availableMemoryBytes: 0,
			sandboxRequestCpuMilli: sandboxRequest.cpuMilli,
			sandboxRequestMemoryBytes: sandboxRequest.memoryBytes,
			availableSandboxSlots: 0,
			totalSchedulableSandboxCapacity: 0,
			schedulableSandboxCapacity: 0,
			cpuLimitedCapacity: 0,
			memoryLimitedCapacity: 0,
			activeSwebenchPods: 0,
			pendingSwebenchPods: 0,
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

/**
 * Per-pod resource usage from the Kubernetes Metrics API.
 *
 * The cluster's metrics-server exposes /apis/metrics.k8s.io/v1beta1/.../pods
 * with a 15-second-rolling CPU + memory snapshot per container — same source
 * `kubectl top` reads. We classify pods by label so the admin dashboard can
 * show "agent runtimes" / "sandboxes" / "platform" totals separately.
 *
 * The workflow-builder ServiceAccount needs metrics.k8s.io/pods (get,list);
 * see ClusterRole-workflow-builder-agent-runtimes.yaml in stacks.
 */

import { getOwnNamespace, kubeApiFetch } from "$lib/server/kube/client";

export interface PodResourceUsage {
	name: string;
	cpuMillicores: number;
	memoryMiB: number;
	class: PodClass;
	labels: Record<string, string>;
}

export type PodClass =
	| "agent-runtime"
	| "sandbox"
	| "workspace-runtime"
	| "workflow-orchestrator"
	| "workflow-builder"
	| "swebench"
	| "other";

export interface ResourceUsageSummary {
	totalCpuMillicores: number;
	totalMemoryMiB: number;
	byClass: Record<PodClass, { count: number; cpuMillicores: number; memoryMiB: number }>;
	pods: PodResourceUsage[];
}

interface MetricsApiContainer {
	name: string;
	usage?: { cpu?: string; memory?: string };
}
interface MetricsApiPod {
	metadata?: { name?: string; namespace?: string; labels?: Record<string, string> };
	containers?: MetricsApiContainer[];
}

/** Parse the Kubernetes resource-quantity for CPU into millicores.
 *  Format: `Nn` (nanocores) | `Nu` (microcores) | `Nm` (millicores) | bare integer cores.
 *  metrics-server emits nanocores in practice. */
function parseCpuToMillicores(raw: string | undefined): number {
	if (!raw) return 0;
	const m = raw.match(/^([0-9.]+)([nuµm]?)$/);
	if (!m) return 0;
	const n = Number(m[1]);
	if (!Number.isFinite(n)) return 0;
	switch (m[2]) {
		case "n":
			return n / 1_000_000; // nanocores → millicores
		case "u":
		case "µ":
			return n / 1000; // microcores → millicores
		case "m":
			return n; // millicores
		case "":
			return n * 1000; // bare cores → millicores
		default:
			return 0;
	}
}

/** Parse a Kubernetes resource-quantity for memory into MiB.
 *  metrics-server typically emits Ki suffix. */
function parseMemoryToMiB(raw: string | undefined): number {
	if (!raw) return 0;
	const m = raw.match(/^([0-9.]+)([KMGTP]i?)?$/);
	if (!m) return 0;
	const n = Number(m[1]);
	if (!Number.isFinite(n)) return 0;
	const unit = m[2] ?? "";
	const factors: Record<string, number> = {
		"": 1 / (1024 * 1024),
		Ki: 1 / 1024,
		Mi: 1,
		Gi: 1024,
		Ti: 1024 * 1024,
		Pi: 1024 * 1024 * 1024,
		K: 1000 / (1024 * 1024),
		M: 1_000_000 / (1024 * 1024),
		G: 1_000_000_000 / (1024 * 1024),
	};
	return n * (factors[unit] ?? 0);
}

function classifyPod(name: string, labels: Record<string, string> | undefined): PodClass {
	const l = labels ?? {};
	if (l["agents.x-k8s.io/role"] === "agent-runtime") return "agent-runtime";
	if (name.startsWith("agent-runtime-")) return "agent-runtime";
	if (name.startsWith("workspace-runtime")) return "workspace-runtime";
	if (name.startsWith("workflow-orchestrator")) return "workflow-orchestrator";
	if (name.startsWith("workflow-builder")) return "workflow-builder";
	if (name.startsWith("swebench-evaluator-") || name.startsWith("swebench-coordinator-"))
		return "swebench";
	if (l["app.kubernetes.io/name"] === "openshell-sandbox") return "sandbox";
	if (name.includes("sandbox")) return "sandbox";
	return "other";
}

const EMPTY_BUCKET = { count: 0, cpuMillicores: 0, memoryMiB: 0 };

export async function getResourceUsage(namespace?: string): Promise<ResourceUsageSummary> {
	const ns = namespace ?? (await getOwnNamespace());
	const res = await kubeApiFetch(
		`/apis/metrics.k8s.io/v1beta1/namespaces/${encodeURIComponent(ns)}/pods`,
	);
	if (!res.ok) {
		throw new Error(
			`getResourceUsage ${ns} failed: ${res.status} ${await res.text()}`,
		);
	}
	const body = (await res.json()) as { items?: MetricsApiPod[] };
	const items = body.items ?? [];

	const pods: PodResourceUsage[] = [];
	const byClass: Record<PodClass, { count: number; cpuMillicores: number; memoryMiB: number }> = {
		"agent-runtime": { ...EMPTY_BUCKET },
		sandbox: { ...EMPTY_BUCKET },
		"workspace-runtime": { ...EMPTY_BUCKET },
		"workflow-orchestrator": { ...EMPTY_BUCKET },
		"workflow-builder": { ...EMPTY_BUCKET },
		swebench: { ...EMPTY_BUCKET },
		other: { ...EMPTY_BUCKET },
	};

	let totalCpu = 0;
	let totalMem = 0;

	for (const p of items) {
		const name = p.metadata?.name ?? "";
		if (!name) continue;
		const labels = p.metadata?.labels ?? {};
		const cpu = (p.containers ?? []).reduce(
			(acc, c) => acc + parseCpuToMillicores(c.usage?.cpu),
			0,
		);
		const mem = (p.containers ?? []).reduce(
			(acc, c) => acc + parseMemoryToMiB(c.usage?.memory),
			0,
		);
		const cls = classifyPod(name, labels);
		const pod: PodResourceUsage = {
			name,
			cpuMillicores: Math.round(cpu),
			memoryMiB: Math.round(mem),
			class: cls,
			labels,
		};
		pods.push(pod);
		const bucket = byClass[cls];
		bucket.count += 1;
		bucket.cpuMillicores += pod.cpuMillicores;
		bucket.memoryMiB += pod.memoryMiB;
		totalCpu += pod.cpuMillicores;
		totalMem += pod.memoryMiB;
	}

	return {
		totalCpuMillicores: Math.round(totalCpu),
		totalMemoryMiB: Math.round(totalMem),
		byClass,
		pods,
	};
}

/**
 * Single-pod actual usage from the Metrics API — cheap targeted read for the
 * per-session "Compute" tile (avoids listing every pod in the namespace).
 * Returns null when metrics-server has no sample yet (pod just started) or the
 * pod is gone.
 */
export async function getPodResourceUsage(
	podName: string,
	namespace?: string,
): Promise<{ name: string; cpuMillicores: number; memoryMiB: number } | null> {
	const ns = namespace ?? (await getOwnNamespace());
	const res = await kubeApiFetch(
		`/apis/metrics.k8s.io/v1beta1/namespaces/${encodeURIComponent(ns)}/pods/${encodeURIComponent(podName)}`,
	);
	if (!res.ok) return null; // 404 = no sample yet / pod gone
	const p = (await res.json()) as MetricsApiPod;
	const cpu = (p.containers ?? []).reduce(
		(acc, c) => acc + parseCpuToMillicores(c.usage?.cpu),
		0,
	);
	const mem = (p.containers ?? []).reduce(
		(acc, c) => acc + parseMemoryToMiB(c.usage?.memory),
		0,
	);
	return { name: podName, cpuMillicores: Math.round(cpu), memoryMiB: Math.round(mem) };
}

// Re-export for tests / future per-execution wiring
export { parseCpuToMillicores, parseMemoryToMiB, classifyPod };

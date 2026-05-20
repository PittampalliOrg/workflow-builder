export const DEFAULT_HEADLAMP_URL = "https://headlamp-hub.tail286401.ts.net";

export const HEADLAMP_CLUSTERS = ["hub", "ryzen", "dev", "staging"] as const;

export type HeadlampCluster = (typeof HEADLAMP_CLUSTERS)[number];

export type HeadlampResourceKind =
	| "DaemonSet"
	| "Deployment"
	| "Job"
	| "Pod"
	| "ReplicaSet"
	| "StatefulSet";

const RESOURCE_PATHS: Record<HeadlampResourceKind, string> = {
	DaemonSet: "daemonsets",
	Deployment: "deployments",
	Job: "jobs",
	Pod: "pods",
	ReplicaSet: "replicasets",
	StatefulSet: "statefulsets",
};

const LOGGABLE_RESOURCE_KINDS = new Set<HeadlampResourceKind>([
	"DaemonSet",
	"Deployment",
	"Job",
	"ReplicaSet",
	"StatefulSet",
]);

function trimBase(base: string | null | undefined): string | null {
	const value = (base ?? DEFAULT_HEADLAMP_URL).trim().replace(/\/+$/, "");
	return value || null;
}

export function normalizeHeadlampCluster(value: string | null | undefined): HeadlampCluster {
	const normalized = (value ?? "").trim().toLowerCase();
	return HEADLAMP_CLUSTERS.includes(normalized as HeadlampCluster)
		? (normalized as HeadlampCluster)
		: "ryzen";
}

export function headlampResourceUrl(input: {
	headlampBase?: string | null;
	cluster: HeadlampCluster;
	kind: HeadlampResourceKind;
	namespace: string | null | undefined;
	name: string | null | undefined;
	logs?: boolean;
}): string | null {
	const base = trimBase(input.headlampBase);
	const namespace = input.namespace?.trim();
	const name = input.name?.trim();
	if (!base || !namespace || !name) return null;

	const path = RESOURCE_PATHS[input.kind];
	const url = `${base}/c/${encodeURIComponent(input.cluster)}/${path}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
	return input.logs && LOGGABLE_RESOURCE_KINDS.has(input.kind) ? `${url}?view=logs` : url;
}

export function headlampCustomResourceUrl(input: {
	headlampBase?: string | null;
	cluster: HeadlampCluster;
	crd: string | null | undefined;
	namespace: string | null | undefined;
	name: string | null | undefined;
}): string | null {
	const base = trimBase(input.headlampBase);
	const crd = input.crd?.trim();
	const namespace = input.namespace?.trim();
	const name = input.name?.trim();
	if (!base || !crd || !namespace || !name) return null;
	return `${base}/c/${encodeURIComponent(input.cluster)}/customresources/${encodeURIComponent(crd)}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
}

export type KueueResourceKind =
	| "ClusterQueue"
	| "LocalQueue"
	| "Workload"
	| "ResourceFlavor"
	| "Cohort";

const KUEUE_CRDS: Record<KueueResourceKind, string> = {
	ClusterQueue: "clusterqueues.kueue.x-k8s.io",
	LocalQueue: "localqueues.kueue.x-k8s.io",
	Workload: "workloads.kueue.x-k8s.io",
	ResourceFlavor: "resourceflavors.kueue.x-k8s.io",
	Cohort: "cohorts.kueue.x-k8s.io",
};

// Headlamp uses "-" as the namespace placeholder for cluster-scoped CRs.
const CLUSTER_SCOPED_KUEUE: ReadonlySet<KueueResourceKind> = new Set([
	"ClusterQueue",
	"ResourceFlavor",
	"Cohort",
]);

export function headlampKueueUrl(input: {
	headlampBase?: string | null;
	cluster: HeadlampCluster;
	kind: KueueResourceKind;
	namespace?: string | null;
	name: string | null | undefined;
}): string | null {
	const namespace = CLUSTER_SCOPED_KUEUE.has(input.kind)
		? "-"
		: input.namespace?.trim() || null;
	return headlampCustomResourceUrl({
		headlampBase: input.headlampBase,
		cluster: input.cluster,
		crd: KUEUE_CRDS[input.kind],
		namespace,
		name: input.name,
	});
}

// Headlamp cluster index (used for the cluster badge in the Capacity Overview).
export function headlampClusterUrl(input: {
	headlampBase?: string | null;
	cluster: HeadlampCluster;
}): string | null {
	const base = trimBase(input.headlampBase);
	if (!base) return null;
	return `${base}/c/${encodeURIComponent(input.cluster)}/`;
}

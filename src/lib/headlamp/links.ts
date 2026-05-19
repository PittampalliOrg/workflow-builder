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

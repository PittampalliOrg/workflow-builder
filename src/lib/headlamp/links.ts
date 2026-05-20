export const DEFAULT_HEADLAMP_URL = "https://headlamp-hub.tail286401.ts.net";
export const DEFAULT_HEADLAMP_EMBED_BASE = "/headlamp";

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

function trimEmbedBase(base: string | null | undefined): string {
	const value = (base ?? DEFAULT_HEADLAMP_EMBED_BASE).trim().replace(/\/+$/, "");
	return value || DEFAULT_HEADLAMP_EMBED_BASE;
}

function appendPath(base: string, path: string): string {
	const normalizedPath = normalizeEmbeddedHeadlampPath(path);
	if (normalizedPath === "/") return `${base}/`;
	return `${base}${normalizedPath}`;
}

export function normalizeHeadlampCluster(value: string | null | undefined): HeadlampCluster {
	const normalized = (value ?? "").trim().toLowerCase();
	return HEADLAMP_CLUSTERS.includes(normalized as HeadlampCluster)
		? (normalized as HeadlampCluster)
		: "ryzen";
}

export function normalizeEmbeddedHeadlampPath(value: string | null | undefined): string {
	const raw = (value ?? "/").trim();
	if (!raw || raw.startsWith("//") || raw.includes("\\")) return "/";

	let parsed: URL;
	try {
		if (/^https?:\/\//i.test(raw)) {
			parsed = new URL(raw);
		} else if (raw.startsWith("/")) {
			parsed = new URL(raw, "http://headlamp.local");
		} else {
			return "/";
		}
	} catch {
		return "/";
	}

	let pathname = parsed.pathname || "/";
	if (pathname === DEFAULT_HEADLAMP_EMBED_BASE) {
		pathname = "/";
	} else if (pathname.startsWith(`${DEFAULT_HEADLAMP_EMBED_BASE}/`)) {
		pathname = pathname.slice(DEFAULT_HEADLAMP_EMBED_BASE.length) || "/";
	}

	if (pathname === "/") return "/";
	if (!pathname.startsWith("/c/")) return "/";

	const [, prefix, cluster] = pathname.split("/");
	if (prefix !== "c") return "/";
	try {
		if (!HEADLAMP_CLUSTERS.includes(decodeURIComponent(cluster) as HeadlampCluster)) {
			return "/";
		}
	} catch {
		return "/";
	}

	return `${pathname}${parsed.search}`;
}

export function isValidEmbeddedHeadlampPath(value: string | null | undefined): boolean {
	const normalized = normalizeEmbeddedHeadlampPath(value);
	return normalized !== "/" || (value ?? "/").trim() === "/" || (value ?? "").trim() === "";
}

export function headlampResourcePath(input: {
	cluster: HeadlampCluster;
	kind: HeadlampResourceKind;
	namespace: string | null | undefined;
	name: string | null | undefined;
	logs?: boolean;
}): string | null {
	const namespace = input.namespace?.trim();
	const name = input.name?.trim();
	if (!namespace || !name) return null;

	const path = RESOURCE_PATHS[input.kind];
	const url = `/c/${encodeURIComponent(input.cluster)}/${path}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
	return input.logs && LOGGABLE_RESOURCE_KINDS.has(input.kind) ? `${url}?view=logs` : url;
}

export function headlampResourceUrl(input: {
	headlampBase?: string | null;
	cluster: HeadlampCluster;
	kind: HeadlampResourceKind;
	namespace: string | null | undefined;
	name: string | null | undefined;
	logs?: boolean;
}): string | null {
	const path = headlampResourcePath(input);
	return path ? headlampExternalUrl({ headlampBase: input.headlampBase, path }) : null;
}

export function headlampCustomResourcePath(input: {
	cluster: HeadlampCluster;
	crd: string | null | undefined;
	namespace: string | null | undefined;
	name: string | null | undefined;
}): string | null {
	const crd = input.crd?.trim();
	const namespace = input.namespace?.trim();
	const name = input.name?.trim();
	if (!crd || !namespace || !name) return null;
	return `/c/${encodeURIComponent(input.cluster)}/customresources/${encodeURIComponent(crd)}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
}

export function headlampCustomResourceUrl(input: {
	headlampBase?: string | null;
	cluster: HeadlampCluster;
	crd: string | null | undefined;
	namespace: string | null | undefined;
	name: string | null | undefined;
}): string | null {
	const path = headlampCustomResourcePath(input);
	return path ? headlampExternalUrl({ headlampBase: input.headlampBase, path }) : null;
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

export function headlampKueuePath(input: {
	cluster: HeadlampCluster;
	kind: KueueResourceKind;
	namespace?: string | null;
	name: string | null | undefined;
}): string | null {
	const namespace = CLUSTER_SCOPED_KUEUE.has(input.kind)
		? "-"
		: input.namespace?.trim() || null;
	return headlampCustomResourcePath({
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
	return headlampExternalUrl({
		headlampBase: input.headlampBase,
		path: headlampClusterPath(input),
	});
}

export function headlampClusterPath(input: { cluster: HeadlampCluster }): string {
	return `/c/${encodeURIComponent(input.cluster)}/`;
}

export function headlampExternalUrl(input: {
	headlampBase?: string | null;
	path: string | null | undefined;
}): string | null {
	const base = trimBase(input.headlampBase);
	const path = normalizeEmbeddedHeadlampPath(input.path);
	if (!base) return null;
	return appendPath(base, path);
}

export function headlampEmbedSrc(input: {
	embedBase?: string | null;
	path: string | null | undefined;
}): string {
	return appendPath(trimEmbedBase(input.embedBase), normalizeEmbeddedHeadlampPath(input.path));
}

export function embeddedHeadlampWorkspaceUrl(input: {
	workspaceSlug: string | null | undefined;
	path: string | null | undefined;
}): string | null {
	const workspaceSlug = input.workspaceSlug?.trim();
	if (!workspaceSlug) return null;
	const path = normalizeEmbeddedHeadlampPath(input.path);
	const params = new URLSearchParams({ path });
	return `/workspaces/${encodeURIComponent(workspaceSlug)}/kubernetes?${params.toString()}`;
}

export function embeddedHeadlampResourceUrl(input: {
	workspaceSlug: string | null | undefined;
	cluster: HeadlampCluster;
	kind: HeadlampResourceKind;
	namespace: string | null | undefined;
	name: string | null | undefined;
	logs?: boolean;
}): string | null {
	const path = headlampResourcePath(input);
	return path ? embeddedHeadlampWorkspaceUrl({ workspaceSlug: input.workspaceSlug, path }) : null;
}

export function embeddedHeadlampCustomResourceUrl(input: {
	workspaceSlug: string | null | undefined;
	cluster: HeadlampCluster;
	crd: string | null | undefined;
	namespace: string | null | undefined;
	name: string | null | undefined;
}): string | null {
	const path = headlampCustomResourcePath(input);
	return path ? embeddedHeadlampWorkspaceUrl({ workspaceSlug: input.workspaceSlug, path }) : null;
}

export function embeddedHeadlampKueueUrl(input: {
	workspaceSlug: string | null | undefined;
	cluster: HeadlampCluster;
	kind: KueueResourceKind;
	namespace?: string | null;
	name: string | null | undefined;
}): string | null {
	const path = headlampKueuePath(input);
	return path ? embeddedHeadlampWorkspaceUrl({ workspaceSlug: input.workspaceSlug, path }) : null;
}

export function embeddedHeadlampClusterUrl(input: {
	workspaceSlug: string | null | undefined;
	cluster: HeadlampCluster;
}): string | null {
	return embeddedHeadlampWorkspaceUrl({
		workspaceSlug: input.workspaceSlug,
		path: headlampClusterPath(input),
	});
}

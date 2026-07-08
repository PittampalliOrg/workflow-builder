import { readFileSync } from "node:fs";
import https from "node:https";

const DEV_NAMESPACE = process.env.WORKFLOW_TARGET_DEV_NAMESPACE ?? "workflow-builder";
const PREVIEW_NAMESPACE_LABEL =
	process.env.WORKFLOW_TARGET_PREVIEW_NAMESPACE_LABEL ?? "app=vcluster-preview";
const WORKFLOW_BUILDER_URL =
	process.env.WORKFLOW_BUILDER_URL ??
	"http://workflow-builder.workflow-builder.svc.cluster.local:3000";
const DEV_MCP_URL =
	process.env.WORKFLOW_MCP_INTERNAL_URL ??
	"http://workflow-mcp-server.workflow-builder.svc.cluster.local:3200";
const DEV_APP_TAILNET_URL =
	process.env.WORKFLOW_BUILDER_PUBLIC_URL ??
	process.env.PUBLIC_WORKFLOW_BUILDER_URL ??
	"https://workflow-builder-dev.tail286401.ts.net";
const DEV_MCP_TAILNET_URL =
	process.env.WORKFLOW_MCP_PUBLIC_URL ??
	process.env.PUBLIC_WORKFLOW_MCP_URL ??
	"https://workflow-builder-mcp-dev.tail286401.ts.net";

const SA_TOKEN_PATH =
	"/var/run/secrets/kubernetes.io/serviceaccount/token";
const SA_CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";

type KubeObjectMeta = {
	name: string;
	namespace?: string;
	labels?: Record<string, string>;
	annotations?: Record<string, string>;
	creationTimestamp?: string;
};

type KubeList<T> = {
	items: T[];
};

type KubeNamespace = {
	metadata: KubeObjectMeta;
};

type KubeService = {
	metadata: KubeObjectMeta;
	spec?: {
		type?: string;
		clusterIP?: string;
		ports?: Array<{
			name?: string;
			port?: number;
			targetPort?: number | string;
			protocol?: string;
		}>;
	};
	status?: {
		loadBalancer?: {
			ingress?: Array<{ hostname?: string; ip?: string }>;
		};
	};
};

type KubePod = {
	metadata: KubeObjectMeta;
	status?: {
		phase?: string;
		podIP?: string;
		containerStatuses?: Array<{ ready?: boolean }>;
	};
};

type KubeDeployment = {
	metadata: KubeObjectMeta;
	status?: {
		replicas?: number;
		readyReplicas?: number;
		availableReplicas?: number;
		updatedReplicas?: number;
	};
};

export type WorkflowTargetKind = "dev" | "preview";

export type WorkflowTargetInfo = {
	target: string;
	kind: WorkflowTargetKind;
	name: string;
	namespace: string;
	alias?: string;
	poolState?: string;
	claimedBy?: string;
	claimedAt?: string;
	lastActive?: string;
	createdAt?: string;
	urls: {
		workflowBuilderInternal?: string;
		workflowBuilderTailnet?: string;
		mcpInternal?: string;
		mcpTailnet?: string;
		kubeApiTailnet?: string;
	};
	capabilities: {
		workflowBuilder: boolean;
		mcpProxy: boolean;
		kubeApi: boolean;
	};
};

export type ResolvedWorkflowTarget = {
	local: boolean;
	info: WorkflowTargetInfo;
	mcpBaseUrl?: string;
};

export type TargetHealth = {
	target: WorkflowTargetInfo;
	checks: Array<{
		name: string;
		ok: boolean;
		detail?: unknown;
		error?: string;
	}>;
};

export type TargetResources = {
	target: WorkflowTargetInfo;
	services: Array<{
		name: string;
		type?: string;
		objectName?: string;
		objectNamespace?: string;
		ports: number[];
		tailnetHosts: string[];
	}>;
	pods: Array<{
		name: string;
		phase?: string;
		readyContainers: number;
		totalContainers: number;
		podIP?: string;
	}>;
	deployments: Array<{
		name: string;
		replicas?: number;
		readyReplicas?: number;
		availableReplicas?: number;
		updatedReplicas?: number;
	}>;
};

class KubeApiError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
	}
}

function hasKubernetesServiceAccount(): boolean {
	return Boolean(
		process.env.KUBERNETES_SERVICE_HOST && process.env.KUBERNETES_SERVICE_PORT,
	);
}

function kubeApiRequest<T>(path: string): Promise<T> {
	if (!hasKubernetesServiceAccount()) {
		return Promise.reject(
			new KubeApiError("Kubernetes service account environment is not available"),
		);
	}
	const token = readFileSync(SA_TOKEN_PATH, "utf-8").trim();
	const ca = readFileSync(SA_CA_PATH);
	const hostname = process.env.KUBERNETES_SERVICE_HOST!;
	const port = Number(process.env.KUBERNETES_SERVICE_PORT ?? 443);

	return new Promise<T>((resolve, reject) => {
		const req = https.request(
			{
				hostname,
				port,
				path,
				method: "GET",
				ca,
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${token}`,
				},
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf-8");
					if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) {
						reject(
							new KubeApiError(
								`Kubernetes API ${res.statusCode}: ${text || res.statusMessage}`,
								res.statusCode,
							),
						);
						return;
					}
					try {
						resolve(text ? (JSON.parse(text) as T) : ({} as T));
					} catch (error) {
						reject(error);
					}
				});
			},
		);
		req.on("error", reject);
		req.end();
	});
}

function query(params: Record<string, string | undefined>): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value) search.set(key, value);
	}
	const rendered = search.toString();
	return rendered ? `?${rendered}` : "";
}

async function listNamespaces(): Promise<KubeNamespace[]> {
	const result = await kubeApiRequest<KubeList<KubeNamespace>>(
		`/api/v1/namespaces${query({ labelSelector: PREVIEW_NAMESPACE_LABEL })}`,
	);
	return result.items ?? [];
}

async function listServices(namespace: string): Promise<KubeService[]> {
	const result = await kubeApiRequest<KubeList<KubeService>>(
		`/api/v1/namespaces/${encodeURIComponent(namespace)}/services`,
	);
	return result.items ?? [];
}

async function listPods(namespace: string): Promise<KubePod[]> {
	const result = await kubeApiRequest<KubeList<KubePod>>(
		`/api/v1/namespaces/${encodeURIComponent(namespace)}/pods`,
	);
	return result.items ?? [];
}

async function listDeployments(namespace: string): Promise<KubeDeployment[]> {
	const result = await kubeApiRequest<KubeList<KubeDeployment>>(
		`/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments`,
	);
	return result.items ?? [];
}

function objectName(service: KubeService): string | undefined {
	return service.metadata.annotations?.["vcluster.loft.sh/object-name"];
}

function objectNamespace(service: KubeService): string | undefined {
	return service.metadata.annotations?.["vcluster.loft.sh/object-namespace"];
}

function servicePort(service: KubeService, fallback: number): number {
	return service.spec?.ports?.find((p) => p.port === fallback)?.port ?? fallback;
}

function serviceUrl(namespace: string, service: KubeService, port: number): string {
	return `http://${service.metadata.name}.${namespace}.svc.cluster.local:${port}`;
}

function tailnetHosts(service?: KubeService): string[] {
	return (
		service?.status?.loadBalancer?.ingress
			?.map((ingress) => ingress.hostname)
			.filter((host): host is string => Boolean(host)) ?? []
	);
}

function firstTailnetUrl(service?: KubeService): string | undefined {
	const host = tailnetHosts(service)[0];
	return host ? `https://${host}` : undefined;
}

function findSyncedService(
	services: KubeService[],
	name: string,
	port: number,
): KubeService | undefined {
	return services.find(
		(service) =>
			objectName(service) === name &&
			objectNamespace(service) === "workflow-builder" &&
			service.spec?.ports?.some((p) => p.port === port),
	);
}

function findNamedService(
	services: KubeService[],
	name: string,
): KubeService | undefined {
	return services.find((service) => service.metadata.name === name);
}

function buildDevTarget(): WorkflowTargetInfo {
	return {
		target: "dev",
		kind: "dev",
		name: "dev",
		namespace: DEV_NAMESPACE,
		urls: {
			workflowBuilderInternal: WORKFLOW_BUILDER_URL,
			workflowBuilderTailnet: DEV_APP_TAILNET_URL,
			mcpInternal: DEV_MCP_URL,
			mcpTailnet: DEV_MCP_TAILNET_URL,
		},
		capabilities: {
			workflowBuilder: true,
			mcpProxy: false,
			kubeApi: hasKubernetesServiceAccount(),
		},
	};
}

function buildPreviewTarget(
	namespace: KubeNamespace,
	services: KubeService[],
): WorkflowTargetInfo {
	const labels = namespace.metadata.labels ?? {};
	const annotations = namespace.metadata.annotations ?? {};
	const namespaceName = namespace.metadata.name;
	const name =
		labels["vcluster-preview-name"] ??
		namespaceName.replace(/^vcluster-/, "");
	const alias = labels["vcluster-preview-alias"];
	const workflowBuilder = findSyncedService(services, "workflow-builder", 3000);
	const workflowMcp = findSyncedService(services, "workflow-mcp-server", 3200);
	const appTailnet =
		findNamedService(services, "workflow-builder-claim-tailnet") ??
		findNamedService(services, "workflow-builder-preview-tailnet");
	const mcpTailnet = findNamedService(
		services,
		"workflow-mcp-server-preview-tailnet",
	);
	const kubeApiTailnet = findNamedService(services, "kube-api-tailnet");

	return {
		target: `preview:${name}`,
		kind: "preview",
		name,
		namespace: namespaceName,
		...(alias ? { alias } : {}),
		...(labels["vcluster-preview-pool"]
			? { poolState: labels["vcluster-preview-pool"] }
			: {}),
		...(annotations["vcluster-preview-claimed-by"]
			? { claimedBy: annotations["vcluster-preview-claimed-by"] }
			: {}),
		...(annotations["vcluster-preview-claimed-at"]
			? { claimedAt: annotations["vcluster-preview-claimed-at"] }
			: {}),
		...(annotations["vcluster-preview-last-active"]
			? { lastActive: annotations["vcluster-preview-last-active"] }
			: {}),
		...(namespace.metadata.creationTimestamp
			? { createdAt: namespace.metadata.creationTimestamp }
			: {}),
		urls: {
			...(workflowBuilder
				? {
						workflowBuilderInternal: serviceUrl(
							namespaceName,
							workflowBuilder,
							servicePort(workflowBuilder, 3000),
						),
					}
				: {}),
			...(firstTailnetUrl(appTailnet)
				? { workflowBuilderTailnet: firstTailnetUrl(appTailnet) }
				: {}),
			...(workflowMcp
				? {
						mcpInternal: serviceUrl(
							namespaceName,
							workflowMcp,
							servicePort(workflowMcp, 3200),
						),
					}
				: {}),
			...(firstTailnetUrl(mcpTailnet)
				? { mcpTailnet: firstTailnetUrl(mcpTailnet) }
				: {}),
			...(firstTailnetUrl(kubeApiTailnet)
				? { kubeApiTailnet: firstTailnetUrl(kubeApiTailnet) }
				: {}),
		},
		capabilities: {
			workflowBuilder: Boolean(workflowBuilder),
			mcpProxy: Boolean(workflowMcp),
			kubeApi: Boolean(kubeApiTailnet),
		},
	};
}

function isDevTarget(target?: string): boolean {
	if (!target || !target.trim()) return true;
	const normalized = target.trim().toLowerCase();
	return normalized === "dev" || normalized === "host" || normalized === "local";
}

function normalizePreviewTarget(target: string): string {
	const trimmed = target.trim();
	return trimmed.startsWith("preview:") ? trimmed.slice("preview:".length) : trimmed;
}

function previewTargetMatches(info: WorkflowTargetInfo, requested: string): boolean {
	const wanted = normalizePreviewTarget(requested);
	const wantedWithoutNamespace = wanted.replace(/^vcluster-/, "");
	return [
		info.name,
		info.namespace,
		info.namespace.replace(/^vcluster-/, ""),
		info.alias,
	].some((candidate) => candidate === wanted || candidate === wantedWithoutNamespace);
}

export async function listWorkflowTargets(): Promise<{
	targets: WorkflowTargetInfo[];
	discoveryError?: string;
}> {
	const dev = buildDevTarget();
	if (!hasKubernetesServiceAccount()) {
		return {
			targets: [dev],
			discoveryError:
				"Not running with a Kubernetes service account; preview target discovery is unavailable.",
		};
	}

	try {
		const namespaces = await listNamespaces();
		const previews = await Promise.all(
			namespaces.map(async (namespace) =>
				buildPreviewTarget(namespace, await listServices(namespace.metadata.name)),
			),
		);
		previews.sort((a, b) => a.target.localeCompare(b.target));
		return { targets: [dev, ...previews] };
	} catch (error) {
		return {
			targets: [dev],
			discoveryError:
				error instanceof Error ? error.message : `Discovery failed: ${String(error)}`,
		};
	}
}

export async function resolveWorkflowTarget(
	target?: string,
): Promise<ResolvedWorkflowTarget> {
	if (isDevTarget(target)) {
		const info = buildDevTarget();
		return { local: true, info, mcpBaseUrl: info.urls.mcpInternal };
	}

	const { targets, discoveryError } = await listWorkflowTargets();
	const resolved = targets.find(
		(info) => info.kind === "preview" && previewTargetMatches(info, target!),
	);
	if (!resolved) {
		const available = targets
			.filter((info) => info.kind === "preview")
			.map((info) => info.target)
			.join(", ");
		throw new Error(
			`Workflow target "${target}" was not found.${
				available ? ` Available preview targets: ${available}.` : ""
			}${discoveryError ? ` Discovery error: ${discoveryError}` : ""}`,
		);
	}
	if (!resolved.urls.mcpInternal) {
		throw new Error(
			`Workflow target "${resolved.target}" does not have a synced workflow-mcp-server ClusterIP service yet.`,
		);
	}
	return { local: false, info: resolved, mcpBaseUrl: resolved.urls.mcpInternal };
}

async function httpJsonHealth(url: string): Promise<{
	ok: boolean;
	status?: number;
	body?: unknown;
	error?: string;
}> {
	try {
		const resp = await fetch(url, {
			signal: AbortSignal.timeout(5_000),
		});
		const text = await resp.text();
		let body: unknown = text;
		try {
			body = text ? JSON.parse(text) : null;
		} catch {
			body = text;
		}
		return { ok: resp.ok, status: resp.status, body };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function getWorkflowTargetHealth(
	target?: string,
): Promise<TargetHealth> {
	const resolved = await resolveWorkflowTarget(target);
	const checks: TargetHealth["checks"] = [];

	if (resolved.info.urls.workflowBuilderInternal) {
		const health = await httpJsonHealth(
			`${resolved.info.urls.workflowBuilderInternal}/api/health`,
		);
		checks.push({
			name: "workflow-builder-api",
			ok: health.ok,
			detail: { status: health.status, body: health.body },
			...(health.error ? { error: health.error } : {}),
		});
	} else {
		checks.push({
			name: "workflow-builder-api",
			ok: false,
			error: "No workflow-builder ClusterIP service discovered for this target.",
		});
	}

	if (resolved.info.urls.mcpInternal) {
		const health = await httpJsonHealth(`${resolved.info.urls.mcpInternal}/health`);
		checks.push({
			name: "workflow-mcp-server",
			ok: health.ok,
			detail: { status: health.status, body: health.body },
			...(health.error ? { error: health.error } : {}),
		});
	} else {
		checks.push({
			name: "workflow-mcp-server",
			ok: false,
			error: "No workflow-mcp-server ClusterIP service discovered for this target.",
		});
	}

	return { target: resolved.info, checks };
}

export async function getWorkflowTargetResources(
	target?: string,
): Promise<TargetResources> {
	const resolved = await resolveWorkflowTarget(target);
	const namespace = resolved.info.namespace;
	const [services, pods, deployments] = await Promise.all([
		listServices(namespace),
		listPods(namespace),
		listDeployments(namespace),
	]);

	return {
		target: resolved.info,
		services: services.map((service) => ({
			name: service.metadata.name,
			type: service.spec?.type,
			objectName: objectName(service),
			objectNamespace: objectNamespace(service),
			ports: service.spec?.ports?.map((port) => port.port ?? 0) ?? [],
			tailnetHosts: tailnetHosts(service),
		})),
		pods: pods.map((pod) => {
			const statuses = pod.status?.containerStatuses ?? [];
			return {
				name: pod.metadata.name,
				phase: pod.status?.phase,
				readyContainers: statuses.filter((status) => status.ready).length,
				totalContainers: statuses.length,
				podIP: pod.status?.podIP,
			};
		}),
		deployments: deployments.map((deployment) => ({
			name: deployment.metadata.name,
			replicas: deployment.status?.replicas,
			readyReplicas: deployment.status?.readyReplicas,
			availableReplicas: deployment.status?.availableReplicas,
			updatedReplicas: deployment.status?.updatedReplicas,
		})),
	};
}

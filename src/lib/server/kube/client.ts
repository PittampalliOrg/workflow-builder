/**
 * Minimal in-cluster Kubernetes API client used by the BFF to CRUD
 * AgentRuntime CRs (agents.x-k8s.io/v1alpha1). We don't pull in
 * @kubernetes/client-node because (a) we only need a handful of operations
 * and (b) it pulls in a 5MB dependency tree.
 *
 * Auth: in-cluster service account token + CA cert, mounted by kubelet at
 * /var/run/secrets/kubernetes.io/serviceaccount/ when the pod runs with
 * automountServiceAccountToken: true (default).
 *
 * The workflow-builder Deployment needs RBAC to manage AgentRuntime CRs;
 * see packages/base/manifests/openshell/ClusterRole-workflow-builder-agent-runtimes.yaml
 * in stacks (added alongside this file).
 */

import fs from "node:fs/promises";
import https from "node:https";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import yaml from "js-yaml";

const TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";
const NAMESPACE_PATH =
	"/var/run/secrets/kubernetes.io/serviceaccount/namespace";

// Per-agent runtime pods now live in workflow-builder (same ns as the
// orchestrator) so Dapr workflow sub-orchestration can resolve the
// child workflow's actor type in the parent's namespace. The env var
// override exists only for the rollback path — flip to "openshell" to
// reverse the namespace move without a rebuild.
const DEFAULT_AGENT_RUNTIME_NAMESPACE =
	process.env.AGENT_RUNTIME_NAMESPACE ?? "workflow-builder";
// Inside a pod Kubernetes sets KUBERNETES_SERVICE_HOST + KUBERNETES_SERVICE_PORT
// (numeric). The plain KUBERNETES_PORT var is a URL like `tcp://10.98.0.1:443`,
// not a bare port — don't use it.
const K8S_HOST =
	process.env.KUBERNETES_SERVICE_HOST ??
	process.env.KUBERNETES_HOST ??
	"kubernetes.default.svc";
const K8S_PORT = process.env.KUBERNETES_SERVICE_PORT ?? "443";

let cachedToken: string | null = null;
let cachedAgent: https.Agent | null = null;
let cachedNamespace: string | null = null;

export async function getToken(): Promise<string> {
	if (cachedToken) return cachedToken;
	const raw = await fs.readFile(TOKEN_PATH, "utf-8");
	cachedToken = raw.trim();
	return cachedToken;
}

async function getAgent(): Promise<https.Agent> {
	if (cachedAgent) return cachedAgent;
	const ca = await fs.readFile(CA_PATH);
	cachedAgent = new https.Agent({ ca, keepAlive: true });
	return cachedAgent;
}

/** Raw CA cert buffer — exported so the WS exec client can build its
 *  own TLS options without colliding on the https.Agent cache. */
let cachedCa: Buffer | null = null;
export async function getKubeCA(): Promise<Buffer> {
	if (cachedCa) return cachedCa;
	cachedCa = await fs.readFile(CA_PATH);
	return cachedCa;
}

export const KUBE_HOST = K8S_HOST;
export const KUBE_PORT = K8S_PORT;

export async function getOwnNamespace(): Promise<string> {
	if (cachedNamespace) return cachedNamespace;
	try {
		const raw = await fs.readFile(NAMESPACE_PATH, "utf-8");
		cachedNamespace = raw.trim();
	} catch {
		cachedNamespace = "workflow-builder";
	}
	return cachedNamespace;
}

export type KubeContainerSpec = {
	name?: string;
	image?: string;
	imagePullPolicy?: string;
	resources?: {
		requests?: Record<string, string | number>;
		limits?: Record<string, string | number>;
	};
};

export type KubeDeployment = {
	metadata?: {
		name?: string;
		namespace?: string;
		labels?: Record<string, string>;
		annotations?: Record<string, string>;
		creationTimestamp?: string;
		generation?: number;
	};
	spec?: {
		replicas?: number;
		selector?: {
			matchLabels?: Record<string, string>;
		};
		template?: {
			metadata?: {
				labels?: Record<string, string>;
			};
			spec?: {
				containers?: KubeContainerSpec[];
				initContainers?: KubeContainerSpec[];
			};
		};
	};
	status?: {
		observedGeneration?: number;
		replicas?: number;
		updatedReplicas?: number;
		readyReplicas?: number;
		availableReplicas?: number;
		unavailableReplicas?: number;
		conditions?: Array<{
			type?: string;
			status?: string;
			reason?: string;
			message?: string;
			lastTransitionTime?: string;
		}>;
	};
};

export type KubePod = {
	metadata?: {
		name?: string;
		namespace?: string;
		labels?: Record<string, string>;
		creationTimestamp?: string;
	};
	spec?: {
		nodeName?: string;
		containers?: KubeContainerSpec[];
		initContainers?: KubeContainerSpec[];
	};
	status?: {
		phase?: string;
		podIP?: string;
		startTime?: string;
		containerStatuses?: Array<{
			name?: string;
			ready?: boolean;
			restartCount?: number;
			image?: string;
			imageID?: string;
		}>;
		initContainerStatuses?: Array<{
			name?: string;
			ready?: boolean;
			restartCount?: number;
			image?: string;
			imageID?: string;
		}>;
		conditions?: Array<{
			type?: string;
			status?: string;
			reason?: string;
			message?: string;
			lastTransitionTime?: string;
		}>;
	};
};

export type KubeNode = {
	metadata?: {
		name?: string;
		labels?: Record<string, string>;
	};
	spec?: {
		unschedulable?: boolean;
		taints?: Array<{
			key?: string;
			value?: string;
			effect?: string;
		}>;
	};
	status?: {
		allocatable?: Record<string, string | number>;
		conditions?: Array<{
			type?: string;
			status?: string;
			reason?: string;
			message?: string;
			lastTransitionTime?: string;
		}>;
	};
};

export type DaprComponent = {
	metadata?: {
		name?: string;
		namespace?: string;
	};
	scopes?: string[];
	spec?: {
		type?: string;
		version?: string;
		metadata?: Array<{
			name?: string;
			value?: unknown;
			secretKeyRef?: {
				name?: string;
				key?: string;
			};
		}>;
	};
};

export async function listDeployments(
	namespace?: string,
): Promise<KubeDeployment[]> {
	const ns = namespace ?? (await getOwnNamespace());
	const res = await kubeFetch(
		`/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/deployments`,
	);
	if (!res.ok) {
		throw new Error(
			`listDeployments ${ns} failed: ${res.status} ${await res.text()}`,
		);
	}
	const body = (await res.json()) as { items?: KubeDeployment[] };
	return body.items ?? [];
}

export async function listPods(namespace?: string): Promise<KubePod[]> {
	const ns = namespace ?? (await getOwnNamespace());
	const res = await kubeFetch(
		`/api/v1/namespaces/${encodeURIComponent(ns)}/pods`,
	);
	if (!res.ok) {
		throw new Error(`listPods ${ns} failed: ${res.status} ${await res.text()}`);
	}
	const body = (await res.json()) as { items?: KubePod[] };
	return body.items ?? [];
}

export async function listPodsAllNamespaces(): Promise<KubePod[]> {
	const res = await kubeFetch("/api/v1/pods");
	if (!res.ok) {
		throw new Error(
			`listPods all namespaces failed: ${res.status} ${await res.text()}`,
		);
	}
	const body = (await res.json()) as { items?: KubePod[] };
	return body.items ?? [];
}

export async function listNodes(): Promise<KubeNode[]> {
	const res = await kubeFetch("/api/v1/nodes");
	if (!res.ok) {
		throw new Error(`listNodes failed: ${res.status} ${await res.text()}`);
	}
	const body = (await res.json()) as { items?: KubeNode[] };
	return body.items ?? [];
}

export async function listDaprComponents(
	namespace?: string,
): Promise<DaprComponent[]> {
	const ns = namespace ?? (await getOwnNamespace());
	const res = await kubeFetch(
		`/apis/dapr.io/v1alpha1/namespaces/${encodeURIComponent(ns)}/components`,
	);
	if (!res.ok) {
		throw new Error(
			`listDaprComponents ${ns} failed: ${res.status} ${await res.text()}`,
		);
	}
	const body = (await res.json()) as { items?: DaprComponent[] };
	return body.items ?? [];
}

type KubeRequestInit = RequestInit & { retries?: number };

type KubeconfigNamedCluster = {
	name?: string;
	cluster?: Record<string, unknown>;
};

type KubeconfigNamedContext = {
	name?: string;
	context?: Record<string, unknown>;
};

type KubeconfigNamedUser = {
	name?: string;
	user?: Record<string, unknown>;
};

type KubeconfigDocument = {
	"current-context"?: string;
	clusters?: KubeconfigNamedCluster[];
	contexts?: KubeconfigNamedContext[];
	users?: KubeconfigNamedUser[];
};

type KubeconfigFetchOptions = {
	kubeconfigPath?: string | null;
	kubeconfigContent?: string | null;
	context?: string | null;
};

/**
 * One-shot https.request wrapped in a Response-compatible interface.
 * We avoid the global fetch() because undici's fetch ignores the
 * `agent` option, leaving no way to supply the kube CA cert — the
 * handshake then fails with the opaque "TypeError: fetch failed".
 */
function httpsRequest(
	url: string,
	method: string,
	headers: Record<string, string>,
	body: string | undefined,
	agent: https.Agent,
): Promise<Response> {
	return new Promise((resolve, reject) => {
		const u = new URL(url);
		const req = https.request(
			{
				hostname: u.hostname,
				port: u.port || 443,
				path: `${u.pathname}${u.search}`,
				method,
				headers:
					body !== undefined
						? { ...headers, "Content-Length": String(Buffer.byteLength(body)) }
						: headers,
				agent,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c) => chunks.push(Buffer.from(c)));
				res.on("end", () => {
					const buf = Buffer.concat(chunks);
					resolve(
						new Response(buf, {
							status: res.statusCode ?? 0,
							statusText: res.statusMessage ?? "",
							headers: Object.fromEntries(
								Object.entries(res.headers).flatMap(([k, v]) =>
									v === undefined
										? []
										: [[k, Array.isArray(v) ? v.join(", ") : v]],
								),
							),
						}),
					);
				});
				res.on("error", reject);
			},
		);
		req.on("error", reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
}

export async function kubeApiFetch(
	path: string,
	init: KubeRequestInit = {},
): Promise<Response> {
	const token = await getToken();
	const agent = await getAgent();
	const url = `https://${K8S_HOST}:${K8S_PORT}${path}`;
	const retries = init.retries ?? 2;
	// Node's Headers normalizes keys to lowercase on iteration. Keep the
	// lowercase form as our internal shape so header-presence checks work
	// regardless of the caller's casing, then http.request handles mixed
	// case correctly over the wire.
	const hdrs: Record<string, string> = {
		authorization: `Bearer ${token}`,
		accept: "application/json",
	};
	if (init.headers) {
		for (const [k, v] of new Headers(init.headers)) hdrs[k.toLowerCase()] = v;
	}
	const bodyStr =
		init.body === undefined || init.body === null
			? undefined
			: typeof init.body === "string"
				? init.body
				: String(init.body);
	if (bodyStr !== undefined && !hdrs["content-type"]) {
		hdrs["content-type"] = "application/json";
	}
	const method = (init.method ?? "GET").toUpperCase();

	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const res = await httpsRequest(url, method, hdrs, bodyStr, agent);
			if (res.status >= 500 && attempt < retries) {
				await sleep(200 * (attempt + 1));
				continue;
			}
			return res;
		} catch (err) {
			if (attempt >= retries) throw err;
			await sleep(200 * (attempt + 1));
		}
	}
	throw new Error("kubeFetch: exhausted retries");
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function readString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function findNamed<T extends { name?: string }>(
	items: T[] | undefined,
	name: string,
	kind: string,
): T {
	const item = items?.find((entry) => entry.name === name);
	if (!item) throw new Error(`kubeconfig ${kind} ${name} not found`);
	return item;
}

async function kubeconfigFileValue(
	value: unknown,
	baseDir: string | null,
): Promise<Buffer | undefined> {
	const path = readString(value);
	if (!path) return undefined;
	return fs.readFile(baseDir ? resolve(baseDir, path) : path);
}

function kubeconfigDataValue(value: unknown): Buffer | undefined {
	const encoded = readString(value);
	return encoded ? Buffer.from(encoded, "base64") : undefined;
}

async function loadKubeconfigAuth(options: KubeconfigFetchOptions) {
	const raw =
		readString(options.kubeconfigContent) ??
		(options.kubeconfigPath
			? await fs.readFile(options.kubeconfigPath, "utf-8")
			: null);
	if (!raw) throw new Error("kubeconfig content or path is required");
	const baseDir = options.kubeconfigPath
		? dirname(options.kubeconfigPath)
		: null;
	const doc = yaml.load(raw) as KubeconfigDocument | null;
	const contextName =
		readString(options.context) ?? readString(doc?.["current-context"]);
	if (!contextName) throw new Error("kubeconfig current-context is required");
	const context = asRecord(
		findNamed(doc?.contexts, contextName, "context").context,
	);
	const clusterName = readString(context.cluster);
	const userName = readString(context.user);
	if (!clusterName)
		throw new Error(`kubeconfig context ${contextName} is missing cluster`);
	if (!userName)
		throw new Error(`kubeconfig context ${contextName} is missing user`);

	const cluster = asRecord(
		findNamed(doc?.clusters, clusterName, "cluster").cluster,
	);
	const user = asRecord(findNamed(doc?.users, userName, "user").user);
	const server = readString(cluster.server);
	if (!server)
		throw new Error(`kubeconfig cluster ${clusterName} is missing server`);

	const ca =
		kubeconfigDataValue(cluster["certificate-authority-data"]) ??
		(await kubeconfigFileValue(cluster["certificate-authority"], baseDir));
	const cert =
		kubeconfigDataValue(user["client-certificate-data"]) ??
		(await kubeconfigFileValue(user["client-certificate"], baseDir));
	const key =
		kubeconfigDataValue(user["client-key-data"]) ??
		(await kubeconfigFileValue(user["client-key"], baseDir));
	const token = readString(user.token) ?? readString(user["id-token"]);
	const username = readString(user.username);
	const password = readString(user.password);
	const rejectUnauthorized =
		cluster["insecure-skip-tls-verify"] === true ? false : undefined;
	if (!token && !(cert && key) && !(username && password)) {
		throw new Error(
			`kubeconfig user ${userName} must use token, basic auth, or client certificate auth`,
		);
	}

	const headers: Record<string, string> = {};
	if (token) headers.authorization = `Bearer ${token}`;
	if (!token && username && password) {
		headers.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
	}

	return {
		server,
		headers,
		agent: new https.Agent({
			ca,
			cert,
			key,
			rejectUnauthorized,
			keepAlive: true,
		}),
	};
}

export async function kubeApiFetchFromKubeconfig(
	path: string,
	init: KubeRequestInit = {},
	options: KubeconfigFetchOptions = {},
): Promise<Response> {
	const auth = await loadKubeconfigAuth(options);
	const retries = init.retries ?? 2;
	const hdrs: Record<string, string> = {
		authorization: auth.headers.authorization ?? "",
		accept: "application/json",
	};
	if (!hdrs.authorization) delete hdrs.authorization;
	if (init.headers) {
		for (const [k, v] of new Headers(init.headers)) hdrs[k.toLowerCase()] = v;
	}
	const bodyStr =
		init.body === undefined || init.body === null
			? undefined
			: typeof init.body === "string"
				? init.body
				: String(init.body);
	if (bodyStr !== undefined && !hdrs["content-type"]) {
		hdrs["content-type"] = "application/json";
	}
	const method = (init.method ?? "GET").toUpperCase();
	const url = `${auth.server.replace(/\/+$/, "")}${path}`;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const res = await httpsRequest(url, method, hdrs, bodyStr, auth.agent);
			if (res.status >= 500 && attempt < retries) {
				await sleep(200 * (attempt + 1));
				continue;
			}
			return res;
		} catch (err) {
			if (attempt >= retries) throw err;
			await sleep(200 * (attempt + 1));
		}
	}
	throw new Error("kubeconfig fetch: exhausted retries");
}

const kubeFetch = kubeApiFetch;

// ---------------------------------------------------------------------------
// Agent-runtime pod inspection helpers
// ---------------------------------------------------------------------------
//
// After Arc 3, the legacy `AgentRuntime` CR + custom Kopf controller are
// gone — agents are backed by upstream `kubernetes-sigs/agent-sandbox`
// primitives (per-session `Sandbox` for non-browser agents in Arc 1; per-
// agent `SandboxTemplate` + `SandboxWarmPool` + per-slug `Service` for
// browser/Playwright agents in Arc 2).
//
// What stays here is the small label-selector-based pod-discovery surface
// that the BFF needs for the shell proxy + live-browser features. It looks
// up pods by the stable `app=agent-runtime-<slug>` label that both the
// SandboxTemplate (Arc 2) and the legacy controller stamped, so the same
// helper works during and after the cutover.

export function agentRuntimeName(agentSlug: string): string {
	return `agent-runtime-${agentSlug}`;
}

/** Minimal Pod shape used by the BFF for live-view features. */
export type AgentRuntimePodInfo = {
	name: string;
	namespace: string;
	podIP: string;
	containers: Array<{ name: string; ready: boolean }>;
};

/**
 * Return the full Running pod (name + IP + container-readiness list) for the
 * agent-runtime pod of the given slug. The shell proxy needs `metadata.name`
 * for the k8s exec URL; the browser state panel needs the same IP the VNC
 * route used. One call pays for both.
 */
export async function getAgentRuntimePod(
	agentSlug: string,
	namespace = DEFAULT_AGENT_RUNTIME_NAMESPACE,
): Promise<AgentRuntimePodInfo | null> {
	const dep = agentRuntimeName(agentSlug);
	const selector = encodeURIComponent(`app=${dep}`);
	const res = await kubeFetch(
		`/api/v1/namespaces/${namespace}/pods?labelSelector=${selector}`,
	);
	if (!res.ok) return null;
	const body = (await res.json()) as {
		items?: Array<{
			metadata?: { name?: string; namespace?: string };
			status?: {
				phase?: string;
				podIP?: string;
				containerStatuses?: Array<{ name?: string; ready?: boolean }>;
			};
		}>;
	};
	for (const pod of body.items ?? []) {
		if (pod.status?.phase !== "Running") continue;
		const name = pod.metadata?.name;
		const podIP = pod.status?.podIP;
		if (!name || !podIP) continue;
		const containers = (pod.status?.containerStatuses ?? [])
			.filter(
				(c): c is { name: string; ready: boolean } =>
					typeof c.name === "string",
			)
			.map((c) => ({ name: c.name, ready: c.ready === true }));
		return {
			name,
			namespace: pod.metadata?.namespace ?? namespace,
			podIP,
			containers,
		};
	}
	return null;
}

export async function getAgentRuntimePodIP(
	agentSlug: string,
	namespace = DEFAULT_AGENT_RUNTIME_NAMESPACE,
): Promise<string | null> {
	const dep = agentRuntimeName(agentSlug);
	const selector = encodeURIComponent(`app=${dep}`);
	const res = await kubeFetch(
		`/api/v1/namespaces/${namespace}/pods?labelSelector=${selector}`,
	);
	if (!res.ok) return null;
	const body = (await res.json()) as {
		items?: Array<{
			status?: {
				phase?: string;
				podIP?: string;
				containerStatuses?: Array<{ name?: string; ready?: boolean }>;
			};
		}>;
	};
	for (const pod of body.items ?? []) {
		const phase = pod.status?.phase;
		if (phase !== "Running") continue;
		const chromium = (pod.status?.containerStatuses ?? []).find(
			(c) => c.name === "chromium",
		);
		if (!chromium?.ready) continue;
		if (pod.status?.podIP) return pod.status.podIP;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Upstream `kubernetes-sigs/agent-sandbox` helpers
// ---------------------------------------------------------------------------
//
// SandboxTemplate + SandboxWarmPool back per-agent runtime pods for
// browser/Playwright agents. Browser/Playwright agents publish a per-slug
// SandboxTemplate (full pod shape with chromium
// + playwright-mcp sidecars) and a per-slug SandboxWarmPool referencing it;
// scaling 0↔1 happens by patching the pool's `spec.replicas` (replaces the
// old wake/sleep annotation handshake).

const SANDBOX_GROUP = "agents.x-k8s.io";
const SANDBOX_EXTENSIONS_GROUP = "extensions.agents.x-k8s.io";
const SANDBOX_API_VERSION = "v1alpha1";

function sandboxTemplatePath(
	name: string,
	namespace = DEFAULT_AGENT_RUNTIME_NAMESPACE,
): string {
	return `/apis/${SANDBOX_EXTENSIONS_GROUP}/${SANDBOX_API_VERSION}/namespaces/${namespace}/sandboxtemplates/${name}`;
}

function sandboxTemplateCollectionPath(
	namespace = DEFAULT_AGENT_RUNTIME_NAMESPACE,
): string {
	return `/apis/${SANDBOX_EXTENSIONS_GROUP}/${SANDBOX_API_VERSION}/namespaces/${namespace}/sandboxtemplates`;
}

function sandboxWarmPoolPath(
	name: string,
	namespace = DEFAULT_AGENT_RUNTIME_NAMESPACE,
): string {
	return `/apis/${SANDBOX_EXTENSIONS_GROUP}/${SANDBOX_API_VERSION}/namespaces/${namespace}/sandboxwarmpools/${name}`;
}

function sandboxWarmPoolCollectionPath(
	namespace = DEFAULT_AGENT_RUNTIME_NAMESPACE,
): string {
	return `/apis/${SANDBOX_EXTENSIONS_GROUP}/${SANDBOX_API_VERSION}/namespaces/${namespace}/sandboxwarmpools`;
}

function sandboxWarmPoolScalePath(
	name: string,
	namespace = DEFAULT_AGENT_RUNTIME_NAMESPACE,
): string {
	return `${sandboxWarmPoolPath(name, namespace)}/scale`;
}

function servicePath(
	name: string,
	namespace = DEFAULT_AGENT_RUNTIME_NAMESPACE,
): string {
	return `/api/v1/namespaces/${namespace}/services/${name}`;
}

function serviceCollectionPath(
	namespace = DEFAULT_AGENT_RUNTIME_NAMESPACE,
): string {
	return `/api/v1/namespaces/${namespace}/services`;
}

export type SandboxTemplate = {
	apiVersion: `${typeof SANDBOX_EXTENSIONS_GROUP}/${typeof SANDBOX_API_VERSION}`;
	kind: "SandboxTemplate";
	metadata: {
		name: string;
		namespace: string;
		labels?: Record<string, string>;
		annotations?: Record<string, string>;
		resourceVersion?: string;
	};
	// Upstream controller passes `spec.podTemplate` through to the pods it
	// creates; the schema is a standard Kubernetes PodTemplateSpec.
	spec: {
		podTemplate: {
			metadata?: {
				labels?: Record<string, string>;
				annotations?: Record<string, string>;
			};
			spec: Record<string, unknown>;
		};
		networkPolicy?: Record<string, unknown>;
		networkPolicyManagement?: "Managed" | "Unmanaged";
	};
};

export type SandboxWarmPool = {
	apiVersion: `${typeof SANDBOX_EXTENSIONS_GROUP}/${typeof SANDBOX_API_VERSION}`;
	kind: "SandboxWarmPool";
	metadata: {
		name: string;
		namespace: string;
		labels?: Record<string, string>;
		annotations?: Record<string, string>;
		resourceVersion?: string;
	};
	spec: {
		replicas: number;
		sandboxTemplateRef: { name: string };
	};
	status?: {
		replicas?: number;
		readyReplicas?: number;
	};
};

export function browserAgentSandboxTemplateName(agentSlug: string): string {
	return `agent-runtime-${agentSlug}`;
}

export function browserAgentSandboxWarmPoolName(agentSlug: string): string {
	return `agent-runtime-${agentSlug}`;
}

export function browserAgentMcpServiceName(agentSlug: string): string {
	return `agent-runtime-${agentSlug}-mcp`;
}

export async function upsertSandboxTemplate(
	body: SandboxTemplate,
): Promise<SandboxTemplate> {
	const { name, namespace } = body.metadata;
	const existing = await kubeFetch(sandboxTemplatePath(name, namespace));
	if (existing.status === 404) {
		const res = await kubeFetch(sandboxTemplateCollectionPath(namespace), {
			method: "POST",
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			throw new Error(
				`create SandboxTemplate ${name} failed: ${res.status} ${await res.text()}`,
			);
		}
		return (await res.json()) as SandboxTemplate;
	}
	if (!existing.ok) {
		throw new Error(
			`get SandboxTemplate ${name} failed: ${existing.status} ${await existing.text()}`,
		);
	}
	const res = await kubeFetch(sandboxTemplatePath(name, namespace), {
		method: "PATCH",
		headers: { "Content-Type": "application/merge-patch+json" },
		body: JSON.stringify({
			metadata: {
				labels: body.metadata.labels,
				annotations: body.metadata.annotations,
			},
			spec: body.spec,
		}),
	});
	if (!res.ok) {
		throw new Error(
			`patch SandboxTemplate ${name} failed: ${res.status} ${await res.text()}`,
		);
	}
	return (await res.json()) as SandboxTemplate;
}

export async function deleteSandboxTemplate(
	name: string,
	namespace = DEFAULT_AGENT_RUNTIME_NAMESPACE,
): Promise<void> {
	const res = await kubeFetch(sandboxTemplatePath(name, namespace), {
		method: "DELETE",
	});
	if (res.status !== 404 && !res.ok) {
		throw new Error(
			`delete SandboxTemplate ${name} failed: ${res.status}`,
		);
	}
}

export async function getSandboxWarmPool(
	name: string,
	namespace = DEFAULT_AGENT_RUNTIME_NAMESPACE,
): Promise<SandboxWarmPool | null> {
	const res = await kubeFetch(sandboxWarmPoolPath(name, namespace));
	if (res.status === 404) return null;
	if (!res.ok) {
		throw new Error(
			`get SandboxWarmPool ${name} failed: ${res.status}`,
		);
	}
	return (await res.json()) as SandboxWarmPool;
}

export async function listSandboxWarmPools(
	namespace = DEFAULT_AGENT_RUNTIME_NAMESPACE,
): Promise<SandboxWarmPool[]> {
	const res = await kubeFetch(sandboxWarmPoolCollectionPath(namespace));
	if (!res.ok) {
		throw new Error(`listSandboxWarmPools failed: ${res.status}`);
	}
	const body = (await res.json()) as { items?: SandboxWarmPool[] };
	return body.items ?? [];
}

export async function upsertSandboxWarmPool(
	body: SandboxWarmPool,
): Promise<SandboxWarmPool> {
	const { name, namespace } = body.metadata;
	const existing = await getSandboxWarmPool(name, namespace);
	if (!existing) {
		const res = await kubeFetch(sandboxWarmPoolCollectionPath(namespace), {
			method: "POST",
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			throw new Error(
				`create SandboxWarmPool ${name} failed: ${res.status} ${await res.text()}`,
			);
		}
		return (await res.json()) as SandboxWarmPool;
	}
	// Patch only spec — preserve the live `replicas` count if the wake helper
	// already scaled it up, by overlaying the requested baseline replicas
	// only when the caller explicitly asks for a lower value (via the
	// `body.spec.replicas` field). For an idempotent publish that just
	// re-asserts the template ref, callers should pass the existing replica
	// count to avoid clobbering an in-flight wake.
	const patch: Partial<SandboxWarmPool> = {
		metadata: {
			name,
			namespace,
			labels: { ...existing.metadata.labels, ...body.metadata.labels },
			annotations: {
				...existing.metadata.annotations,
				...body.metadata.annotations,
			},
		},
		spec: body.spec,
	};
	const res = await kubeFetch(sandboxWarmPoolPath(name, namespace), {
		method: "PATCH",
		headers: { "Content-Type": "application/merge-patch+json" },
		body: JSON.stringify(patch),
	});
	if (!res.ok) {
		throw new Error(
			`patch SandboxWarmPool ${name} failed: ${res.status} ${await res.text()}`,
		);
	}
	return (await res.json()) as SandboxWarmPool;
}

export async function setSandboxWarmPoolReplicas(
	name: string,
	replicas: number,
	namespace = DEFAULT_AGENT_RUNTIME_NAMESPACE,
): Promise<void> {
	const res = await kubeFetch(sandboxWarmPoolScalePath(name, namespace), {
		method: "PATCH",
		headers: { "Content-Type": "application/merge-patch+json" },
		body: JSON.stringify({ spec: { replicas } }),
	});
	if (!res.ok) {
		throw new Error(
			`scale SandboxWarmPool ${name} to ${replicas} failed: ${res.status} ${await res.text()}`,
		);
	}
}

export async function deleteSandboxWarmPool(
	name: string,
	namespace = DEFAULT_AGENT_RUNTIME_NAMESPACE,
): Promise<void> {
	const res = await kubeFetch(sandboxWarmPoolPath(name, namespace), {
		method: "DELETE",
	});
	if (res.status !== 404 && !res.ok) {
		throw new Error(
			`delete SandboxWarmPool ${name} failed: ${res.status}`,
		);
	}
}

/**
 * Wake (or keep awake) a SandboxWarmPool by patching `spec.replicas` to
 * `targetReplicas` and waiting for `status.readyReplicas >= targetReplicas`.
 * Replaces the AgentRuntime annotation handshake.
 *
 * Idempotent: if the pool is already at the desired replica count and ready,
 * returns immediately without re-scaling.
 */
export async function wakeSandboxWarmPool(
	agentSlug: string,
	timeoutMs = 30_000,
	{
		targetReplicas = 1,
		namespace = DEFAULT_AGENT_RUNTIME_NAMESPACE,
	}: { targetReplicas?: number; namespace?: string } = {},
): Promise<SandboxWarmPool> {
	const name = browserAgentSandboxWarmPoolName(agentSlug);
	const current = await getSandboxWarmPool(name, namespace);
	if (!current) {
		throw new Error(
			`wakeSandboxWarmPool: SandboxWarmPool ${name} not found in ${namespace}`,
		);
	}
	if ((current.spec.replicas ?? 0) < targetReplicas) {
		await setSandboxWarmPoolReplicas(name, targetReplicas, namespace);
	}

	const deadline = Date.now() + timeoutMs;
	let lastReady = current.status?.readyReplicas ?? 0;
	while (Date.now() < deadline) {
		const cr = await getSandboxWarmPool(name, namespace);
		if (!cr) break;
		const ready = cr.status?.readyReplicas ?? 0;
		if (ready >= targetReplicas) return cr;
		lastReady = ready;
		await sleep(1_000);
	}
	throw new Error(
		`wakeSandboxWarmPool ${name}: timeout after ${timeoutMs}ms; readyReplicas=${lastReady}`,
	);
}

export async function sleepSandboxWarmPool(
	agentSlug: string,
	namespace = DEFAULT_AGENT_RUNTIME_NAMESPACE,
): Promise<void> {
	const name = browserAgentSandboxWarmPoolName(agentSlug);
	await setSandboxWarmPoolReplicas(name, 0, namespace);
}

// Per-slug ClusterIP Service for the playwright-mcp sidecar (port 3100).
// The current BFF expects the DNS name `agent-runtime-<slug>-mcp.<ns>.svc`
// (see `src/lib/server/playwright-mcp-client.ts`); preserving this means
// emitting a Service alongside each SandboxWarmPool. Selector matches the
// pool pod labels stamped by the SandboxTemplate.
export async function upsertAgentRuntimeService(params: {
	agentSlug: string;
	namespace?: string;
	mcpPort?: number;
}): Promise<void> {
	const namespace = params.namespace ?? DEFAULT_AGENT_RUNTIME_NAMESPACE;
	const name = browserAgentMcpServiceName(params.agentSlug);
	const port = params.mcpPort ?? 3100;
	const body = {
		apiVersion: "v1",
		kind: "Service",
		metadata: {
			name,
			namespace,
			labels: {
				"app.kubernetes.io/name": "agent-runtime",
				"app.kubernetes.io/part-of": "workflow-builder",
				"agents.x-k8s.io/slug": params.agentSlug,
				"agents.x-k8s.io/role": "agent-runtime-mcp",
			},
		},
		spec: {
			type: "ClusterIP",
			selector: {
				"agents.x-k8s.io/slug": params.agentSlug,
				"agents.x-k8s.io/role": "agent-runtime",
			},
			ports: [
				{
					name: "mcp",
					port,
					targetPort: port,
					protocol: "TCP",
				},
			],
		},
	};

	const existing = await kubeFetch(servicePath(name, namespace));
	if (existing.status === 404) {
		const res = await kubeFetch(serviceCollectionPath(namespace), {
			method: "POST",
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			throw new Error(
				`create Service ${name} failed: ${res.status} ${await res.text()}`,
			);
		}
		return;
	}
	if (!existing.ok) {
		throw new Error(
			`get Service ${name} failed: ${existing.status} ${await existing.text()}`,
		);
	}
	const res = await kubeFetch(servicePath(name, namespace), {
		method: "PATCH",
		headers: { "Content-Type": "application/merge-patch+json" },
		body: JSON.stringify({
			metadata: { labels: body.metadata.labels },
			spec: body.spec,
		}),
	});
	if (!res.ok) {
		throw new Error(
			`patch Service ${name} failed: ${res.status} ${await res.text()}`,
		);
	}
}

export async function deleteAgentRuntimeService(
	agentSlug: string,
	namespace = DEFAULT_AGENT_RUNTIME_NAMESPACE,
): Promise<void> {
	const name = browserAgentMcpServiceName(agentSlug);
	const res = await kubeFetch(servicePath(name, namespace), {
		method: "DELETE",
	});
	if (res.status !== 404 && !res.ok) {
		throw new Error(`delete Service ${name} failed: ${res.status}`);
	}
}

/**
 * Wake helper that prefers the new upstream `SandboxWarmPool` and falls back
 * to the legacy `AgentRuntime` CR when no warm pool exists yet (e.g., the
 * agent hasn't been re-published since the Arc 2 BFF rolled out). Lets call
 * sites use one signature regardless of which generation of resources back
 * the agent today. Returns a normalized status the public/internal wake APIs
 * can render uniformly.
 */
export type AgentRuntimePhase =
	| "Pending"
	| "Sleeping"
	| "Starting"
	| "Active"
	| "Failed";

export type NormalizedAgentRuntimeStatus = {
	phase: AgentRuntimePhase | "Unknown";
	replicas: number;
	readyReplicas: number;
	source: "sandbox-warm-pool";
};

function deriveSandboxWarmPoolPhase(
	pool: SandboxWarmPool,
): AgentRuntimePhase | "Unknown" {
	const desired = pool.spec?.replicas ?? 0;
	const replicas = pool.status?.replicas ?? 0;
	const ready = pool.status?.readyReplicas ?? 0;
	if (desired === 0 && replicas === 0) return "Sleeping";
	if (desired > 0 && ready >= desired) return "Active";
	if (desired > 0) return "Starting";
	return "Unknown";
}

/**
 * Wake (or keep awake) the per-agent runtime pod by patching the
 * `SandboxWarmPool.spec.replicas` to `targetReplicas` and waiting for
 * `status.readyReplicas >= targetReplicas`. Returns a normalized status the
 * public/internal wake APIs render uniformly.
 *
 * Throws if no SandboxWarmPool exists for the slug — non-browser agents go
 * through per-session `Sandbox` dispatch via sandbox-execution-api and
 * shouldn't reach this wake path.
 */
export async function wakeAgentRuntime(
	agentSlug: string,
	timeoutMs = 30_000,
	namespace = DEFAULT_AGENT_RUNTIME_NAMESPACE,
): Promise<NormalizedAgentRuntimeStatus> {
	const woken = await wakeSandboxWarmPool(agentSlug, timeoutMs, { namespace });
	return {
		phase: deriveSandboxWarmPoolPhase(woken),
		replicas: woken.status?.replicas ?? 0,
		readyReplicas: woken.status?.readyReplicas ?? 0,
		source: "sandbox-warm-pool",
	};
}

export async function sleepAgentRuntime(
	agentSlug: string,
	namespace = DEFAULT_AGENT_RUNTIME_NAMESPACE,
): Promise<void> {
	await sleepSandboxWarmPool(agentSlug, namespace);
}

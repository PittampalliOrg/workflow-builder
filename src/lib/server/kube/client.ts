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
import { setTimeout as sleep } from "node:timers/promises";

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

type KubeRequestInit = RequestInit & { retries?: number };

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
				headers: body !== undefined ? { ...headers, "Content-Length": String(Buffer.byteLength(body)) } : headers,
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
									v === undefined ? [] : [[k, Array.isArray(v) ? v.join(", ") : v]],
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

async function kubeFetch(path: string, init: KubeRequestInit = {}): Promise<Response> {
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

// ---------------------------------------------------------------------------
// AgentRuntime CR helpers
// ---------------------------------------------------------------------------

export type AgentRuntimeMcpServer = {
	name: string;
	transport: "streamable_http" | "sse" | "stdio" | "websocket";
	url?: string;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	headers?: Record<string, string>;
};

export type AgentRuntimeBrowserSidecar = {
	enabled: boolean;
	chromeImage?: string;
	mcpGatewayImage?: string;
	chromeResources?: {
		requests?: Record<string, string>;
		limits?: Record<string, string>;
	};
	mcpResources?: {
		requests?: Record<string, string>;
		limits?: Record<string, string>;
	};
};

export type AgentRuntimeSpec = {
	agentSlug: string;
	projectId?: string | null;
	appId: string;
	environment: {
		id?: string;
		slug?: string;
		version?: number;
		imageTag: string;
	};
	mcpServers?: AgentRuntimeMcpServer[];
	lifecycle?: {
		idleTtlSeconds?: number;
		maxReplicas?: number;
	};
	browserSidecar?: AgentRuntimeBrowserSidecar;
};

export type AgentRuntimeStatus = {
	phase?: "Pending" | "Sleeping" | "Starting" | "Active" | "Failed";
	replicas?: number;
	readyReplicas?: number;
	deploymentRef?: string;
	lastActiveAt?: string;
	lastTransitionTime?: string;
	message?: string;
};

export type AgentRuntime = {
	apiVersion: "agents.x-k8s.io/v1alpha1";
	kind: "AgentRuntime";
	metadata: {
		name: string;
		namespace: string;
		annotations?: Record<string, string>;
		labels?: Record<string, string>;
		resourceVersion?: string;
	};
	spec: AgentRuntimeSpec;
	status?: AgentRuntimeStatus;
};

const GROUP = "agents.x-k8s.io";
const VERSION = "v1alpha1";
const PLURAL = "agentruntimes";

function crPath(name: string, namespace = DEFAULT_AGENT_RUNTIME_NAMESPACE): string {
	return `/apis/${GROUP}/${VERSION}/namespaces/${namespace}/${PLURAL}/${name}`;
}

function crCollectionPath(namespace = DEFAULT_AGENT_RUNTIME_NAMESPACE): string {
	return `/apis/${GROUP}/${VERSION}/namespaces/${namespace}/${PLURAL}`;
}

export function agentRuntimeName(agentSlug: string): string {
	return `agent-runtime-${agentSlug}`;
}

export async function listAgentRuntimes(
	namespace = DEFAULT_AGENT_RUNTIME_NAMESPACE,
): Promise<AgentRuntime[]> {
	const res = await kubeFetch(crCollectionPath(namespace));
	if (!res.ok) {
		throw new Error(`listAgentRuntimes failed: ${res.status}`);
	}
	const body = (await res.json()) as { items?: AgentRuntime[] };
	return body.items ?? [];
}

export async function getAgentRuntime(
	agentSlug: string,
	namespace = DEFAULT_AGENT_RUNTIME_NAMESPACE,
): Promise<AgentRuntime | null> {
	const res = await kubeFetch(crPath(agentRuntimeName(agentSlug), namespace));
	if (res.status === 404) return null;
	if (!res.ok) {
		throw new Error(`getAgentRuntime ${agentSlug} failed: ${res.status}`);
	}
	return (await res.json()) as AgentRuntime;
}

export async function upsertAgentRuntime(
	spec: AgentRuntimeSpec,
	namespace = DEFAULT_AGENT_RUNTIME_NAMESPACE,
): Promise<AgentRuntime> {
	const name = agentRuntimeName(spec.agentSlug);
	const body: AgentRuntime = {
		apiVersion: "agents.x-k8s.io/v1alpha1",
		kind: "AgentRuntime",
		metadata: {
			name,
			namespace,
			labels: {
				"agents.x-k8s.io/slug": spec.agentSlug,
			},
		},
		spec,
	};

	const existing = await getAgentRuntime(spec.agentSlug, namespace);
	if (!existing) {
		const res = await kubeFetch(crCollectionPath(namespace), {
			method: "POST",
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			throw new Error(`create AgentRuntime ${name} failed: ${res.status} ${await res.text()}`);
		}
		return (await res.json()) as AgentRuntime;
	}

	// Patch only the fields we care about — preserve controller-set
	// annotations (wake/sleep/last-active).
	const patch: Partial<AgentRuntime> = {
		metadata: {
			name,
			namespace,
			labels: { ...existing.metadata.labels, ...body.metadata.labels },
		},
		spec,
	};
	const res = await kubeFetch(crPath(name, namespace), {
		method: "PATCH",
		headers: { "Content-Type": "application/merge-patch+json" },
		body: JSON.stringify(patch),
	});
	if (!res.ok) {
		throw new Error(`patch AgentRuntime ${name} failed: ${res.status} ${await res.text()}`);
	}
	return (await res.json()) as AgentRuntime;
}

/**
 * Return the Pod IP of the currently-running agent-runtime pod for the given
 * agent slug, or `null` when no pod is ready. Used by the live-browser WS
 * proxy to dial the chromium sidecar's VNC port (5901) directly — we prefer
 * Pod IP over a per-agent Service because agent-runtime pods are Dapr-app-id
 * routed, not Service routed, and spinning up one Service per agent would
 * explode the service count with the agent catalog.
 *
 * "Ready" here means: pod.phase == Running AND the `chromium` container's
 * ready flag is true. A half-started pod (agent-py up, chromium still
 * pulling) returns null so callers surface "reconnecting" in the UI.
 */
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
			.filter((c): c is { name: string; ready: boolean } => typeof c.name === "string")
			.map((c) => ({ name: c.name, ready: c.ready === true }));
		return { name, namespace: pod.metadata?.namespace ?? namespace, podIP, containers };
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

export async function deleteAgentRuntime(
	agentSlug: string,
	namespace = DEFAULT_AGENT_RUNTIME_NAMESPACE,
): Promise<void> {
	const res = await kubeFetch(crPath(agentRuntimeName(agentSlug), namespace), {
		method: "DELETE",
	});
	if (res.status !== 404 && !res.ok) {
		throw new Error(`delete AgentRuntime ${agentSlug} failed: ${res.status}`);
	}
}

export async function annotateAgentRuntime(
	agentSlug: string,
	annotations: Record<string, string>,
	namespace = DEFAULT_AGENT_RUNTIME_NAMESPACE,
): Promise<void> {
	const patch = { metadata: { annotations } };
	const res = await kubeFetch(crPath(agentRuntimeName(agentSlug), namespace), {
		method: "PATCH",
		headers: { "Content-Type": "application/merge-patch+json" },
		body: JSON.stringify(patch),
	});
	if (!res.ok) {
		throw new Error(
			`annotate AgentRuntime ${agentSlug} failed: ${res.status} ${await res.text()}`,
		);
	}
}

/**
 * Request a runtime be scaled up and wait until status.phase === Active.
 * Idempotent: if the runtime is already Active, returns immediately.
 *
 * @param timeoutMs  hard ceiling before giving up (default 30s for cold
 *                   start). Callers that know the runtime is already warm
 *                   can pass a shorter value.
 */
export async function wakeAgentRuntime(
	agentSlug: string,
	timeoutMs = 30_000,
	namespace = DEFAULT_AGENT_RUNTIME_NAMESPACE,
): Promise<AgentRuntime> {
	const now = new Date().toISOString();
	await annotateAgentRuntime(
		agentSlug,
		{
			"agents.x-k8s.io/wake": now,
			"agents.x-k8s.io/last-active": now,
		},
		namespace,
	);

	const deadline = Date.now() + timeoutMs;
	let lastPhase = "";
	while (Date.now() < deadline) {
		const cr = await getAgentRuntime(agentSlug, namespace);
		if (cr?.status?.phase === "Active") return cr;
		lastPhase = cr?.status?.phase ?? "Unknown";
		await sleep(1_000);
	}
	throw new Error(
		`wakeAgentRuntime ${agentSlug}: timeout after ${timeoutMs}ms; phase=${lastPhase}`,
	);
}

export async function sleepAgentRuntime(
	agentSlug: string,
	namespace = DEFAULT_AGENT_RUNTIME_NAMESPACE,
): Promise<void> {
	await annotateAgentRuntime(
		agentSlug,
		{ "agents.x-k8s.io/sleep": new Date().toISOString() },
		namespace,
	);
}

export async function stampLastActive(
	agentSlug: string,
	namespace = DEFAULT_AGENT_RUNTIME_NAMESPACE,
): Promise<void> {
	await annotateAgentRuntime(
		agentSlug,
		{ "agents.x-k8s.io/last-active": new Date().toISOString() },
		namespace,
	);
}

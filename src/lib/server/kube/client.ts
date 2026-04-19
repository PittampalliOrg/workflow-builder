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

const DEFAULT_AGENT_RUNTIME_NAMESPACE =
	process.env.AGENT_RUNTIME_NAMESPACE ?? "openshell";
const K8S_HOST = process.env.KUBERNETES_HOST ?? "kubernetes.default.svc";
const K8S_PORT = process.env.KUBERNETES_PORT ?? "443";

let cachedToken: string | null = null;
let cachedAgent: https.Agent | null = null;
let cachedNamespace: string | null = null;

async function getToken(): Promise<string> {
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

async function kubeFetch(path: string, init: KubeRequestInit = {}): Promise<Response> {
	const token = await getToken();
	const agent = await getAgent();
	const url = `https://${K8S_HOST}:${K8S_PORT}${path}`;
	const retries = init.retries ?? 2;
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${token}`);
	if (!headers.has("Content-Type") && init.body) {
		headers.set("Content-Type", "application/json");
	}
	headers.set("Accept", "application/json");

	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			// Node's undici fetch honors agent via the `dispatcher` option
			// only when it's a Dispatcher instance; falls back to global when
			// undefined. For raw https.Agent we pass via the nodejs agent option
			// (cast through unknown to dodge the DOM RequestInit type).
			const res = await fetch(url, {
				...init,
				headers,
				agent,
			} as unknown as RequestInit);
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

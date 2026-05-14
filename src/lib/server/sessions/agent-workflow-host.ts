import { error } from "@sveltejs/kit";
import { createHash } from "node:crypto";
import { env } from "$env/dynamic/private";
import { isPlaywrightMcpEntry } from "$lib/server/agents/mcp-sidecar";
import { getAgentWorkflowHostPod } from "$lib/server/kube/client";
import type { AgentConfig } from "$lib/types/agents";

/**
 * Dispatcher for the per-session Kueue-admitted Sandbox path. Used by both:
 *   - `src/routes/api/internal/sessions/ensure-for-workflow/+server.ts`
 *     (workflow-driven `durable/run` sessions)
 *   - `src/lib/server/sessions/spawn.ts`
 *     (UI-direct sessions)
 *
 * When the gate passes, POSTs to `sandbox-execution-api`'s
 * `/api/v1/agent-workflow-hosts` which creates an `agents.x-k8s.io/v1alpha1
 * Sandbox` admitted via Kueue Plain Pod integration. The deterministic
 * `agent-session-<sha20>` app-id is stable for the session's lifetime so
 * Dapr placement registers once and `ctx.call_child_workflow(app_id=...)`
 * routes deterministically.
 *
 * Returns `null` when the gate doesn't apply — callers must fall back to
 * the legacy controller path (`wakeAgentRuntime`). The carve-out below is
 * the load-bearing seam: browser-use-agent and Playwright-MCP agents need
 * a long-lived warm pool (chromium boot ≈ 3-5 s of every run); they stay
 * on the controller until arc 2 migrates them to `SandboxWarmPool`.
 */

function truthyEnv(value: string | undefined): boolean {
	const raw = (value ?? "").trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function agentWorkflowHostBackendEnabled(): boolean {
	const backend = (
		env.AGENT_WORKFLOW_HOST_BACKEND ??
		process.env.AGENT_WORKFLOW_HOST_BACKEND ??
		""
	)
		.trim()
		.toLowerCase()
		.replace(/_/g, "-");
	return (
		backend === "kueue" ||
		backend === "kueue-job" ||
		backend === "host-execution" ||
		truthyEnv(env.AGENT_WORKFLOW_HOSTS_ENABLED ?? process.env.AGENT_WORKFLOW_HOSTS_ENABLED)
	);
}

export function agentConfigCanUseWorkflowHost(
	agentConfig: AgentConfig | null,
): boolean {
	if (!agentConfig) return false;
	if ((agentConfig as { runtime?: unknown }).runtime === "browser-use-agent") {
		return false;
	}
	const servers = Array.isArray(agentConfig.mcpServers) ? agentConfig.mcpServers : [];
	return !servers.some((server) => isPlaywrightMcpEntry(server));
}

export function sessionHostAppId(sessionId: string): string {
	const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 20);
	return `agent-session-${digest}`;
}

function sandboxExecutionApiUrl(): string | null {
	const raw = (
		env.SANDBOX_EXECUTION_API_URL ??
		env.HOST_EXECUTION_API_URL ??
		process.env.SANDBOX_EXECUTION_API_URL ??
		process.env.HOST_EXECUTION_API_URL ??
		""
	).trim();
	return raw ? raw.replace(/\/+$/, "") : null;
}

export interface AgentWorkflowHostResult {
	agentAppId: string;
	sandboxName: string | null;
	status: string | null;
}

export type AgentWorkflowHostAppReadyResult = {
	ok: true;
	attempts: number;
	status: number;
	baseUrl: string;
	podName: string;
	podIP: string;
};

export interface TraceContext {
	traceparent: string | null;
	tracestate: string | null;
	baggage: string | null;
}

/**
 * Extract W3C trace-context headers from an incoming SvelteKit request so
 * they can be forwarded to sandbox-execution-api and ultimately stamped onto
 * the Sandbox CR — letting traces stitch across BFF -> sandbox-execution-api
 * -> daprd -> agent_workflow.
 */
export function extractTraceContext(request: { headers: Headers }): TraceContext {
	return {
		traceparent: request.headers.get("traceparent"),
		tracestate: request.headers.get("tracestate"),
		baggage: request.headers.get("baggage"),
	};
}

export async function maybeProvisionAgentWorkflowHost(params: {
	sessionId: string;
	agentConfig: AgentConfig | null;
	workflowExecutionId: string | null;
	benchmarkRunId: string | null;
	benchmarkInstanceId: string | null;
	timeoutMinutes: number | null;
	priorityClass?: string | null;
	traceContext?: TraceContext | null;
}): Promise<AgentWorkflowHostResult | null> {
	if (!agentWorkflowHostBackendEnabled()) return null;
	if (!agentConfigCanUseWorkflowHost(params.agentConfig)) return null;
	const baseUrl = sandboxExecutionApiUrl();
	if (!baseUrl) {
		throw error(
			503,
			"SANDBOX_EXECUTION_API_URL is required when AGENT_WORKFLOW_HOST_BACKEND=kueue",
		);
	}
	const agentAppId = sessionHostAppId(params.sessionId);
	const timeoutSeconds = Math.max(60, (params.timeoutMinutes ?? 15) * 60);
	const waitReadySecondsRaw = Number(
		env.AGENT_WORKFLOW_HOST_WAIT_READY_SECONDS ??
			process.env.AGENT_WORKFLOW_HOST_WAIT_READY_SECONDS ??
			45,
	);
	const waitReadySeconds = Number.isFinite(waitReadySecondsRaw)
		? Math.max(0, Math.min(55, waitReadySecondsRaw))
		: 45;
	const priorityClass =
		params.priorityClass?.trim() ||
		env.AGENT_WORKFLOW_HOST_PRIORITY_CLASS ||
		process.env.AGENT_WORKFLOW_HOST_PRIORITY_CLASS ||
		"interactive-agent";
	const token = env.INTERNAL_API_TOKEN ?? process.env.INTERNAL_API_TOKEN ?? "";
	const traceHeaders: Record<string, string> = {};
	if (params.traceContext?.traceparent) {
		traceHeaders["traceparent"] = params.traceContext.traceparent;
	}
	if (params.traceContext?.tracestate) {
		traceHeaders["tracestate"] = params.traceContext.tracestate;
	}
	if (params.traceContext?.baggage) {
		traceHeaders["baggage"] = params.traceContext.baggage;
	}
	// Per-runtime container image override. sandbox-execution-api honors
	// `agentImage` on the request body and overrides the executionClass
	// default (`app.py:466`: `image = request.agentImage or class_config.agentHostImage`).
	// For `adk-agent-py` we plumb the dedicated image; everything else falls
	// through to whatever the execution class points to.
	const agentImage = ((): string | null => {
		const runtime = (params.agentConfig as { runtime?: string } | null)?.runtime;
		if (runtime === "adk-agent-py") {
			return (
				env.AGENT_RUNTIME_ADK_DEFAULT_IMAGE ??
				process.env.AGENT_RUNTIME_ADK_DEFAULT_IMAGE ??
				null
			);
		}
		return null;
	})();
	const response = await fetch(`${baseUrl}/api/v1/agent-workflow-hosts`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...traceHeaders,
		},
		body: JSON.stringify({
			sessionId: params.sessionId,
			agentAppId,
			runId: params.benchmarkRunId ?? undefined,
			instanceId:
				params.benchmarkInstanceId ?? params.workflowExecutionId ?? params.sessionId,
			executionClass:
				env.AGENT_WORKFLOW_HOST_EXECUTION_CLASS ??
				process.env.AGENT_WORKFLOW_HOST_EXECUTION_CLASS ??
				"benchmark-fast",
			timeoutSeconds,
			waitReadySeconds,
			priorityClass,
			...(agentImage ? { agentImage } : {}),
		}),
	});
	const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	if (!response.ok) {
		throw error(
			503,
			typeof body.detail === "string"
				? body.detail
				: `agent workflow host provisioning failed with HTTP ${response.status}`,
		);
	}
	const returnedAppId =
		typeof body.agentAppId === "string" && body.agentAppId.trim()
			? body.agentAppId.trim()
			: agentAppId;
	const sandboxName =
		typeof body.sandboxName === "string" && body.sandboxName.trim()
			? body.sandboxName.trim()
			: typeof body.jobName === "string" && body.jobName.trim()
				? body.jobName.trim()
				: null;
	return {
		agentAppId: returnedAppId,
		sandboxName,
		status:
			typeof body.status === "string" && body.status.trim()
				? body.status.trim()
				: null,
	};
}

export async function waitForAgentWorkflowHostAppReady(params: {
	agentAppId: string;
	timeoutSeconds?: number;
	pollMs?: number;
	fetchImpl?: typeof fetch;
}): Promise<AgentWorkflowHostAppReadyResult> {
	const timeoutSeconds =
		params.timeoutSeconds ??
		readBoundedInt(
			env.AGENT_WORKFLOW_HOST_APP_READY_SECONDS ??
				process.env.AGENT_WORKFLOW_HOST_APP_READY_SECONDS,
			60,
			0,
			300,
		);
	if (timeoutSeconds <= 0) {
		throw new Error("agent workflow host app readiness wait is disabled");
	}
	const pollMs = Math.max(0, params.pollMs ?? 1_000);
	const fetchImpl = params.fetchImpl ?? fetch;
	const deadline = Date.now() + timeoutSeconds * 1_000;
	let attempts = 0;
	let lastError = "not attempted";

	while (Date.now() <= deadline) {
		attempts += 1;
		try {
			const pod = await getAgentWorkflowHostPod(params.agentAppId);
			if (!pod) {
				lastError = "pod not found";
				throw new Error(lastError);
			}
			const baseUrl = `http://${pod.podIP}:8002`;
			const url = `${baseUrl}/healthz`;
			const res = await fetchImpl(url, { method: "GET" });
			if (res.ok) {
				return {
					ok: true,
					attempts,
					status: res.status,
					baseUrl,
					podName: pod.name,
					podIP: pod.podIP,
				};
			}
			const text = await res.text().catch(() => "");
			lastError = `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`;
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
		}

		if (Date.now() > deadline) break;
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}

	throw new Error(
		`agent workflow host ${params.agentAppId} app was not reachable after ${timeoutSeconds}s; last error: ${lastError}`,
	);
}

function readBoundedInt(
	value: string | undefined,
	fallback: number,
	min: number,
	max: number,
): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

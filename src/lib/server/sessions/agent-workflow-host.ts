import { error } from "@sveltejs/kit";
import { createHash } from "node:crypto";
import { env } from "$env/dynamic/private";
import { isPlaywrightMcpEntry } from "$lib/server/agents/mcp-sidecar";
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

export async function maybeProvisionAgentWorkflowHost(params: {
	sessionId: string;
	agentConfig: AgentConfig | null;
	workflowExecutionId: string | null;
	benchmarkRunId: string | null;
	benchmarkInstanceId: string | null;
	timeoutMinutes: number | null;
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
	const token = env.INTERNAL_API_TOKEN ?? process.env.INTERNAL_API_TOKEN ?? "";
	const response = await fetch(`${baseUrl}/api/v1/agent-workflow-hosts`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
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

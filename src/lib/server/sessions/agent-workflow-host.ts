import { error } from "@sveltejs/kit";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { createHash } from "node:crypto";
import { env } from "$env/dynamic/private";
import { isPlaywrightMcpEntry } from "$lib/server/agents/mcp-sidecar";
import { getRuntimeDescriptor } from "$lib/server/agents/runtime-registry";
import { resolveImagePin } from "$lib/server/execution/image-pins";
import { getAgentWorkflowHostPod } from "$lib/server/kube/client";
import { responseBodyForSpan } from "$lib/server/dapr-client";
import { setSpanValue } from "$lib/server/observability/content";
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
	const runtime = (agentConfig as { runtime?: string }).runtime;
	if (runtime === "browser-use-agent") {
		return false;
	}
	// Playwright MCP needs chromium + playwright sidecars, which come from a
	// long-lived SandboxWarmPool — and ONLY browser-backed runtimes
	// (`requiresWarmPool`/`requiresBrowserSidecars`, e.g. browser-use-agent) have
	// one. A stray Playwright entry on any OTHER runtime must NOT exclude it from
	// the Kueue Sandbox host: there is no warm pool for it, so spawn would fall
	// through to direct-invoking a non-existent `agent-runtime-<slug>` app-id and
	// the session wedges forever at status=rescheduling (ERR_DIRECT_INVOKE — wfb
	// 2026-06-15). Non-browser runtimes provision Playwright sidecars on the Kueue
	// Sandbox host itself when actually needed, so gate the exclusion on the
	// runtime genuinely requiring a warm pool.
	const descriptor = getRuntimeDescriptor(runtime);
	const needsWarmPool =
		descriptor?.capabilities?.requiresWarmPool === true ||
		descriptor?.capabilities?.requiresBrowserSidecars === true;
	if (needsWarmPool) {
		const servers = Array.isArray(agentConfig.mcpServers) ? agentConfig.mcpServers : [];
		return !servers.some((server) => isPlaywrightMcpEntry(server));
	}
	return true;
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

function trimmedEnv(...names: string[]): string | null {
	for (const name of names) {
		const value = (env[name] ?? process.env[name] ?? "").trim();
		if (value) return value;
	}
	return null;
}

function benchmarkStableAgentWorkflowAppId(): string | null {
	return trimmedEnv(
		"BENCHMARK_AGENT_WORKFLOW_STABLE_APP_ID",
		"BENCHMARK_AGENT_WORKFLOW_HOST_STABLE_APP_ID",
		"BENCHMARK_AGENT_WORKFLOW_HOST_APP_ID",
	);
}

function canUseBenchmarkStableAppId(agentConfig: AgentConfig | null): boolean {
	const runtimeDescriptor = getRuntimeDescriptor(
		(agentConfig as { runtime?: string } | null)?.runtime,
	);
	return runtimeDescriptor?.capabilities.interactiveTerminal !== true;
}

const hostProvisionTracer = trace.getTracer("workflow-builder.agent-workflow-host");

/**
 * Span-safe copy of the provision request body: `sessionSecretEnv` carries
 * raw per-user CLI tokens, so its VALUES must never reach span attributes —
 * keys are kept (useful for debugging which env vars were injected).
 */
function redactSessionSecretEnvForSpan(
	requestBody: Record<string, unknown>,
): Record<string, unknown> {
	const secretEnv = requestBody.sessionSecretEnv;
	if (!secretEnv || typeof secretEnv !== "object") return requestBody;
	return {
		...requestBody,
		sessionSecretEnv: Object.fromEntries(
			Object.keys(secretEnv as Record<string, unknown>).map((key) => [
				key,
				"[redacted]",
			]),
		),
	};
}

async function postAgentWorkflowHost(
	baseUrl: string,
	headers: Record<string, string>,
	requestBody: Record<string, unknown>,
): Promise<{ response: Response; body: Record<string, unknown> }> {
	const url = `${baseUrl}/api/v1/agent-workflow-hosts`;
	return hostProvisionTracer.startActiveSpan(
		"workflow-builder.agentWorkflowHost POST /api/v1/agent-workflow-hosts",
		async (span) => {
			span.setAttribute("http.request.method", "POST");
			span.setAttribute("url.full", url);
			span.setAttribute("url.path", "/api/v1/agent-workflow-hosts");
			span.setAttribute("http.route", "/api/v1/agent-workflow-hosts");
			span.setAttribute("workflow_builder.backend", "sandbox-execution-api");
			setSpanValue(span, "input", redactSessionSecretEnvForSpan(requestBody));
			try {
				const response = await fetch(url, {
					method: "POST",
					headers,
					body: JSON.stringify(requestBody),
				});
				span.setAttribute("http.response.status_code", response.status);
				try {
					setSpanValue(span, "output", await responseBodyForSpan(response));
				} catch {
					setSpanValue(span, "output", {
						status: response.status,
						body: "[response capture failed]",
					});
				}
				if (!response.ok) {
					span.setStatus({
						code: SpanStatusCode.ERROR,
						message: `HTTP ${response.status}`,
					});
				}
				const body = (await response.json().catch(() => ({}))) as Record<
					string,
					unknown
				>;
				return { response, body };
			} catch (caught) {
				const err = caught instanceof Error ? caught : new Error(String(caught));
				setSpanValue(span, "output", {
					ok: false,
					error: err.message,
					target: "/api/v1/agent-workflow-hosts",
				});
				span.recordException(err);
				span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
				throw caught;
			} finally {
				span.end();
			}
		},
	);
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

function agentWorkflowHostTimeoutSeconds(params: {
	timeoutMinutes: number | null;
	workflowExecutionId: string | null;
	benchmarkRunId: string | null;
}): number | null {
	if (
		typeof params.timeoutMinutes === "number" &&
		Number.isFinite(params.timeoutMinutes)
	) {
		return Math.max(60, params.timeoutMinutes * 60);
	}
	// UI-direct interactive sessions are intentionally long-lived. Workflow and
	// benchmark sessions still get a bounded default unless their durable/run
	// config supplies an explicit timeout.
	if (!params.workflowExecutionId && !params.benchmarkRunId) {
		return null;
	}
	return 15 * 60;
}

function agentWorkflowHostExecutionClass(params: {
	benchmarkRunId: string | null;
	benchmarkExecutionClass?: string | null;
	/** Registry-descriptor `executionClass` for the target runtime; overrides
	 * the env default for non-benchmark sessions (e.g. `interactive-cli`). */
	runtimeExecutionClass?: string | null;
}): string {
	if (params.benchmarkRunId) {
		const runtimeExecutionClass = params.runtimeExecutionClass?.trim();
		if (runtimeExecutionClass?.startsWith("interactive-cli")) {
			return runtimeExecutionClass;
		}
		if (params.benchmarkExecutionClass?.trim()) {
			return params.benchmarkExecutionClass.trim();
		}
		return (
			env.BENCHMARK_AGENT_WORKFLOW_HOST_EXECUTION_CLASS ??
			process.env.BENCHMARK_AGENT_WORKFLOW_HOST_EXECUTION_CLASS ??
			env.BENCHMARK_EXECUTION_CLASS ??
			process.env.BENCHMARK_EXECUTION_CLASS ??
			"benchmark-fast"
		);
	}
	if (params.runtimeExecutionClass?.trim()) {
		return params.runtimeExecutionClass.trim();
	}
	return (
		env.AGENT_WORKFLOW_HOST_EXECUTION_CLASS ??
		process.env.AGENT_WORKFLOW_HOST_EXECUTION_CLASS ??
		"interactive-agent"
	);
}

function agentWorkflowHostPriorityClass(params: {
	benchmarkRunId: string | null;
	priorityClass?: string | null;
}): string {
	if (params.priorityClass?.trim()) return params.priorityClass.trim();
	if (params.benchmarkRunId) {
		return (
			env.BENCHMARK_AGENT_WORKFLOW_HOST_PRIORITY_CLASS ??
			process.env.BENCHMARK_AGENT_WORKFLOW_HOST_PRIORITY_CLASS ??
			"swebench-cohort"
		);
	}
	return (
		env.AGENT_WORKFLOW_HOST_PRIORITY_CLASS ??
		process.env.AGENT_WORKFLOW_HOST_PRIORITY_CLASS ??
		"interactive-agent"
	);
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
	benchmarkExecutionClass?: string | null;
	timeoutMinutes: number | null;
	priorityClass?: string | null;
	traceContext?: TraceContext | null;
	/**
	 * Override the readiness wait (seconds). Identity-bound prewarm passes 0 so
	 * the create returns immediately (fire-and-forget) — the real spawn that
	 * later ADOPTS this pod is the one that waits for readiness. Defaults to the
	 * `AGENT_WORKFLOW_HOST_WAIT_READY_SECONDS` env (45) when omitted.
	 */
	waitReadySeconds?: number | null;
	/**
	 * Per-session secret env (e.g. the owner's CLI subscription token for
	 * `interactive-cli` runtimes). sandbox-execution-api creates a per-session
	 * Secret and injects the keys as env into the main container. Values are
	 * redacted from span capture here.
	 */
	sessionSecretEnv?: Record<string, string> | null;
	/**
	 * Interactive-cli resume: the original session id. sandbox-execution-api
	 * keys the per-session durable-transcript CSI subPath on this (falling back
	 * to sessionId), so a resumed pod re-mounts the original conversation's
	 * Postgres-backed transcript subtree.
	 */
	resumeFromSessionId?: string | null;
	/**
	 * Per-EXECUTION shared workspace key (interactive-cli runtime family). When
	 * set, sandbox-execution-api mounts a shared JuiceFS subtree (CSI subPath =
	 * this key) at the class's sharedWorkspaceStoreMountPath, so every CLI pod of
	 * one workflow run reads/writes the SAME files (e.g. a planner→generator→
	 * critic loop sharing SPEC.md + the build). Typically the durable/run
	 * workspaceRef. Ignored by classes that don't enable the shared store.
	 */
	sharedWorkspaceKey?: string | null;
	/**
	 * Hermetic fork: source workspace subPath to SEED this run's fresh workspace
	 * from (read-only copy at sandbox startup). Lets repeated forks of one run be
	 * isolated instead of sharing + drifting on one subtree.
	 */
	seedWorkspaceFrom?: string | null;
}): Promise<AgentWorkflowHostResult | null> {
	if (!agentConfigCanUseWorkflowHost(params.agentConfig)) return null;
	if (params.benchmarkRunId && canUseBenchmarkStableAppId(params.agentConfig)) {
		const stableAppId = benchmarkStableAgentWorkflowAppId();
		if (stableAppId) {
			return {
				agentAppId: stableAppId,
				sandboxName: null,
				status: "stable-app-id",
			};
		}
	}
	if (!agentWorkflowHostBackendEnabled()) return null;
	const baseUrl = sandboxExecutionApiUrl();
	if (!baseUrl) {
		throw error(
			503,
			"SANDBOX_EXECUTION_API_URL is required when AGENT_WORKFLOW_HOST_BACKEND=kueue",
		);
	}
	const agentAppId = sessionHostAppId(params.sessionId);
	const timeoutSeconds = agentWorkflowHostTimeoutSeconds(params);
	const waitReadySecondsRaw =
		params.waitReadySeconds != null
			? params.waitReadySeconds
			: Number(
					env.AGENT_WORKFLOW_HOST_WAIT_READY_SECONDS ??
						process.env.AGENT_WORKFLOW_HOST_WAIT_READY_SECONDS ??
						45,
				);
	// Upper bound on the SYNCHRONOUS readiness wait. The 55s default suits the
	// user-facing interactive spawn (a ~60s ingress/gateway would otherwise cut it
	// off). Preview / workflow-host deployments raise it via
	// AGENT_WORKFLOW_HOST_WAIT_READY_MAX_SECONDS so a COLD agent pod (first image
	// pull + daprd connect + openshell mTLS handshake + LLM warmup, which exceeds
	// 55s) reaches Ready in ONE spawn instead of timing out → re-dispatch → pod
	// churn. Hard-ceilinged at 280s to stay under undici's 300s headersTimeout on
	// the BFF→SEA fetch (the SEA handler holds the whole response until readiness
	// resolves). SEA itself accepts waitReadySeconds ≤ 600.
	const waitReadyMaxRaw = Number(
		env.AGENT_WORKFLOW_HOST_WAIT_READY_MAX_SECONDS ??
			process.env.AGENT_WORKFLOW_HOST_WAIT_READY_MAX_SECONDS ??
			55,
	);
	const waitReadyMax = Number.isFinite(waitReadyMaxRaw)
		? Math.max(0, Math.min(280, waitReadyMaxRaw))
		: 55;
	const waitReadySeconds = Number.isFinite(waitReadySecondsRaw)
		? Math.max(0, Math.min(waitReadyMax, waitReadySecondsRaw))
		: Math.min(45, waitReadyMax);
	const priorityClass = agentWorkflowHostPriorityClass({
		benchmarkRunId: params.benchmarkRunId,
		priorityClass: params.priorityClass,
	});
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
	// Runtimes whose registry descriptor declares an `imageEnvKey` (adk, claude)
	// override the executionClass default with that env var's image; the rest
	// (dapr-agent-py is the default image, browser-use takes the warm-pool lane)
	// declare `imageEnvKey: null` and fall through to the executionClass default.
	const runtimeDescriptor = getRuntimeDescriptor(
		(params.agentConfig as { runtime?: string } | null)?.runtime,
	);
	const agentImage = ((): string | null => {
		const key = runtimeDescriptor?.imageEnvKey;
		if (!key) return null;
		// File-first: the git-synced pin file wins over the pod env, so a
		// re-provisioned session picks up the latest runtime image.
		return resolveImagePin(key, env) ?? resolveImagePin(key, process.env);
	})();
	const sessionSecretEnv =
		params.sessionSecretEnv && Object.keys(params.sessionSecretEnv).length > 0
			? params.sessionSecretEnv
			: null;
	const requestBody = {
		sessionId: params.sessionId,
		agentAppId,
		runId: params.benchmarkRunId ?? undefined,
		instanceId:
			params.benchmarkInstanceId ?? params.workflowExecutionId ?? params.sessionId,
		executionClass: agentWorkflowHostExecutionClass({
			benchmarkRunId: params.benchmarkRunId,
			benchmarkExecutionClass: params.benchmarkExecutionClass,
			runtimeExecutionClass: runtimeDescriptor?.executionClass ?? null,
		}),
		...(timeoutSeconds === null ? {} : { timeoutSeconds }),
		waitReadySeconds,
		priorityClass,
		...(agentImage ? { agentImage } : {}),
		...(sessionSecretEnv ? { sessionSecretEnv } : {}),
		...(params.resumeFromSessionId
			? { resumeFromSessionId: params.resumeFromSessionId }
			: {}),
		...(params.sharedWorkspaceKey
			? { sharedWorkspaceKey: params.sharedWorkspaceKey }
			: {}),
		...(params.seedWorkspaceFrom
			? { seedWorkspaceFrom: params.seedWorkspaceFrom }
			: {}),
	};
	const { response, body } = await postAgentWorkflowHost(
		baseUrl,
		{
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...traceHeaders,
		},
		requestBody,
	);
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

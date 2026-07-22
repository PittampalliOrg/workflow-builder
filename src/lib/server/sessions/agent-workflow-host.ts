import { error } from "@sveltejs/kit";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { env } from "$env/dynamic/private";
import { isPlaywrightMcpEntry } from "$lib/server/agents/mcp-sidecar";
import { getRuntimeDescriptor } from "$lib/server/agents/runtime-registry";
import { resolveImagePin } from "$lib/server/execution/image-pins";
import { getAgentWorkflowHostPod } from "$lib/server/kube/client";
import { responseBodyForSpan } from "$lib/server/dapr-client";
import { setSpanValue } from "$lib/server/observability/content";
import {
  sessionHostAppId as stableSessionHostAppId,
  sessionRuntimeGenerationAppId,
} from "$lib/server/lifecycle/resolvers";
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
    truthyEnv(
      env.AGENT_WORKFLOW_HOSTS_ENABLED ??
        process.env.AGENT_WORKFLOW_HOSTS_ENABLED,
    )
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
    const servers = Array.isArray(agentConfig.mcpServers)
      ? agentConfig.mcpServers
      : [];
		return !servers.some((server) => isPlaywrightMcpEntry(server));
	}
	return true;
}

export function sessionHostAppId(
  sessionId: string,
  provisioningStartedAt?: Date | null,
): string {
  const appId = provisioningStartedAt
    ? sessionRuntimeGenerationAppId(sessionId, provisioningStartedAt)
    : stableSessionHostAppId(sessionId);
  if (!appId) throw new Error("sessionId must be non-empty");
  return appId;
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

const hostProvisionTracer = trace.getTracer(
  "workflow-builder.agent-workflow-host",
);

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
        const waitReadySeconds = Number(requestBody.waitReadySeconds ?? 0);
        const requestTimeoutMs =
          (Math.max(
            0,
            Number.isFinite(waitReadySeconds) ? waitReadySeconds : 0,
          ) +
            30) *
          1_000;
				const response = await fetch(url, {
					method: "POST",
					headers,
					body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(requestTimeoutMs),
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
        const err =
          caught instanceof Error ? caught : new Error(String(caught));
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
  /** Versioned non-secret recipe for recreating this exact app generation. */
  launchSpec?: AgentWorkflowHostLaunchSpec;
	/** SEA-owned ready endpoint. Present only when SEA observed the pod Ready. */
	baseUrl?: string;
	podIP?: string;
	podName?: string;
}

export type AgentWorkflowHostLaunchSpec = {
  version: 1;
  request: Record<string, unknown>;
  secretEnvKeys: string[];
};

/**
 * Rotate provider-owned recovery metadata to a fresh provisional generation.
 * Callers outside this adapter must treat the persisted launch spec as opaque.
 */
export function rotateAgentWorkflowHostLaunchSpecGeneration(params: {
  sessionId: string;
  currentAgentAppId: string;
  currentSandboxName: string;
  provisioningStartedAt: Date;
  launchSpec: Record<string, unknown>;
}): {
  agentAppId: string;
  sandboxName: string;
  launchSpec: AgentWorkflowHostLaunchSpec;
} {
  const raw = params.launchSpec as Partial<AgentWorkflowHostLaunchSpec>;
  if (
    raw.version !== 1 ||
    !raw.request ||
    typeof raw.request !== "object" ||
    Array.isArray(raw.request) ||
    !Array.isArray(raw.secretEnvKeys) ||
    raw.secretEnvKeys.some((key) => typeof key !== "string" || !key.trim())
  ) {
    throw new Error(
      "invalid persisted agent workflow host launch specification",
    );
  }
  const request = raw.request as Record<string, unknown>;
  if (
    request.sessionId !== params.sessionId ||
    request.agentAppId !== params.currentAgentAppId ||
    params.currentSandboxName !== `agent-host-${params.currentAgentAppId}`
  ) {
    throw new Error("persisted agent workflow host generation does not match");
  }
  const agentAppId = sessionHostAppId(
    params.sessionId,
    params.provisioningStartedAt,
  );
  return {
    agentAppId,
    sandboxName: `agent-host-${agentAppId}`,
    launchSpec: {
      version: 1,
      request: { ...request, agentAppId },
      secretEnvKeys: [...raw.secretEnvKeys],
    },
  };
}

export class AgentWorkflowHostActivationError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AgentWorkflowHostActivationError";
  }
}

export function isAgentWorkflowHostAbsentError(
  error: unknown,
): error is AgentWorkflowHostActivationError {
  return (
    error instanceof AgentWorkflowHostActivationError && error.status === 404
  );
}

export type AgentWorkflowHostAppReadyResult = {
	ok: true;
	attempts: number;
	status: number;
	baseUrl: string;
	podName: string;
	podIP: string;
};

type AgentWorkflowHostAppProbeAttempt =
	| { ready: true; result: AgentWorkflowHostAppReadyResult }
	| { ready: false; error: string };

export interface TraceContext {
	traceparent: string | null;
	tracestate: string | null;
	baggage: string | null;
}

function agentWorkflowHostTimeoutSeconds(params: {
	timeoutMinutes: number | null;
	workflowExecutionId: string | null;
	benchmarkRunId: string | null;
	persistentHost?: boolean;
}): number | null {
	if (params.persistentHost) return null;
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
export function extractTraceContext(request: {
  headers: Headers;
}): TraceContext {
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
	/**
	 * Keep a workflow-bound interactive host alive for follow-up messages. Normal
	 * workflow and benchmark hosts remain bounded unless this is explicitly set.
	 */
	persistentHost?: boolean;
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
  /** Exact database lease generation for a lifecycle-fenced dedicated host. */
  provisioningStartedAt?: Date | null;
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
	// Concurrency plan P3: shared-pool runtimes (registry hostMode) skip the
	// per-session Kueue host — returning null makes both spawn.ts and
	// ensure-for-workflow fall back to runtimeRoute.appId, which
	// resolveAgentRuntimeRoute routes to the standing pool Deployment for the
	// runtime class. Sessions multiplex there as workflow instances; per-session
	// config rides childInput. Three overrides force the dedicated host anyway:
	// explicit dedicated isolation, per-session secret env (no delivery channel
	// on a shared pod), and persistentHost (UI sessions that pin their host).
	if (
    getRuntimeDescriptor(
      (params.agentConfig as { runtime?: string } | null)?.runtime,
    )?.hostMode === "shared-pool" &&
    (params.agentConfig as { runtimeIsolation?: string } | null)
      ?.runtimeIsolation !== "dedicated" &&
		Object.keys(params.sessionSecretEnv ?? {}).length === 0 &&
		params.persistentHost !== true
	) {
		return null;
	}
	if (!agentWorkflowHostBackendEnabled()) return null;
	const baseUrl = sandboxExecutionApiUrl();
	if (!baseUrl) {
		throw error(
			503,
			"SANDBOX_EXECUTION_API_URL is required when AGENT_WORKFLOW_HOST_BACKEND=kueue",
		);
	}
  const agentAppId = sessionHostAppId(
    params.sessionId,
    params.provisioningStartedAt,
  );
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
	const token =
		env.SANDBOX_EXECUTION_API_TOKEN ??
		env.HOST_EXECUTION_API_TOKEN ??
		process.env.SANDBOX_EXECUTION_API_TOKEN ??
		process.env.HOST_EXECUTION_API_TOKEN ??
		"";
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
  const requestBody: Record<string, unknown> = {
		sessionId: params.sessionId,
		agentAppId,
    ...(params.benchmarkRunId ? { runId: params.benchmarkRunId } : {}),
		instanceId:
      params.benchmarkInstanceId ??
      params.workflowExecutionId ??
      params.sessionId,
		executionClass: agentWorkflowHostExecutionClass({
			benchmarkRunId: params.benchmarkRunId,
			benchmarkExecutionClass: params.benchmarkExecutionClass,
			runtimeExecutionClass: runtimeDescriptor?.executionClass ?? null,
		}),
		...(timeoutSeconds === null ? {} : { timeoutSeconds }),
    ...(params.provisioningStartedAt
      ? {
          provisionalTimeoutSeconds: readBoundedInt(
            env.AGENT_WORKFLOW_HOST_PROVISIONAL_TIMEOUT_SECONDS ??
              process.env.AGENT_WORKFLOW_HOST_PROVISIONAL_TIMEOUT_SECONDS,
            900,
            300,
            1800,
          ),
        }
      : {}),
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
  const { sessionSecretEnv: _secretValues, ...nonSecretRequest } = requestBody;
  const launchSpec: AgentWorkflowHostLaunchSpec = {
    version: 1,
    request: nonSecretRequest,
    secretEnvKeys: Object.keys(sessionSecretEnv ?? {}).sort(),
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
  if (
    params.provisioningStartedAt &&
    (returnedAppId !== agentAppId || sandboxName !== `agent-host-${agentAppId}`)
  ) {
    throw error(503, "agent workflow host returned a different generation");
  }
	const returnedStatus =
		typeof body.status === "string" && body.status.trim()
			? body.status.trim()
			: null;
	const readyTarget = (() => {
		if (returnedStatus !== "ready") return null;
		const targetBaseUrl =
			typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
		const podIP = typeof body.podIP === "string" ? body.podIP.trim() : "";
		if (!targetBaseUrl || !podIP) return null;
		try {
			const parsed = new URL(targetBaseUrl);
			const expectedHostname = podIP.includes(":") ? `[${podIP}]` : podIP;
			if (
				parsed.protocol !== "http:" ||
				parsed.hostname !== expectedHostname ||
				parsed.port !== "8002" ||
				parsed.username ||
				parsed.password ||
				parsed.pathname !== "/" ||
				parsed.search ||
				parsed.hash
			) {
				return null;
			}
		} catch {
			return null;
		}
		return {
			baseUrl: targetBaseUrl.replace(/\/$/, ""),
			podIP,
			...(typeof body.podName === "string" && body.podName.trim()
				? { podName: body.podName.trim() }
				: {}),
		};
	})();
	return {
		agentAppId: returnedAppId,
		sandboxName,
		status: returnedStatus,
    launchSpec,
		...(readyTarget ?? {}),
	};
}

const RECOVERABLE_HOST_REQUEST_FIELDS = new Set([
  "sessionId",
  "agentAppId",
  "runId",
  "instanceId",
  "executionClass",
  "timeoutSeconds",
  "provisionalTimeoutSeconds",
  "waitReadySeconds",
  "priorityClass",
  "agentImage",
  "resumeFromSessionId",
  "sharedWorkspaceKey",
  "seedWorkspaceFrom",
]);

function parseAgentWorkflowHostLaunchSpec(params: {
  launchSpec: Record<string, unknown>;
  agentAppId: string;
  sandboxName: string;
  sessionSecretEnv?: Record<string, string> | null;
}): Record<string, unknown> {
  const raw = params.launchSpec as Partial<AgentWorkflowHostLaunchSpec>;
  if (
    raw.version !== 1 ||
    !raw.request ||
    typeof raw.request !== "object" ||
    Array.isArray(raw.request) ||
    !Array.isArray(raw.secretEnvKeys) ||
    raw.secretEnvKeys.some((key) => typeof key !== "string" || !key.trim())
  ) {
    throw new Error(
      "invalid persisted agent workflow host launch specification",
    );
  }
  const request = raw.request as Record<string, unknown>;
  for (const key of Object.keys(request)) {
    if (!RECOVERABLE_HOST_REQUEST_FIELDS.has(key)) {
      throw new Error(
        `unsupported persisted agent workflow host field: ${key}`,
      );
    }
  }
  for (const key of [
    "sessionId",
    "agentAppId",
    "instanceId",
    "executionClass",
    "priorityClass",
  ]) {
    if (typeof request[key] !== "string" || !String(request[key]).trim()) {
      throw new Error(`persisted agent workflow host field ${key} is invalid`);
    }
  }
  if (request.agentAppId !== params.agentAppId) {
    throw new Error("persisted agent workflow host generation does not match");
  }
  if (params.sandboxName !== `agent-host-${params.agentAppId}`) {
    throw new Error(
      "persisted agent workflow host Sandbox identity does not match",
    );
  }
  for (const key of [
    "timeoutSeconds",
    "provisionalTimeoutSeconds",
    "waitReadySeconds",
  ]) {
    if (
      request[key] !== undefined &&
      (typeof request[key] !== "number" || !Number.isFinite(request[key]))
    ) {
      throw new Error(`persisted agent workflow host field ${key} is invalid`);
    }
  }
  if (
    typeof request.provisionalTimeoutSeconds !== "number" ||
    request.provisionalTimeoutSeconds < 60 ||
    request.provisionalTimeoutSeconds > 3_600
  ) {
    throw new Error(
      "persisted agent workflow host recovery must remain provider-provisional",
    );
  }
  for (const key of [
    "runId",
    "agentImage",
    "resumeFromSessionId",
    "sharedWorkspaceKey",
    "seedWorkspaceFrom",
  ]) {
    if (request[key] !== undefined && typeof request[key] !== "string") {
      throw new Error(`persisted agent workflow host field ${key} is invalid`);
    }
  }
  const expectedSecretKeys = [...new Set(raw.secretEnvKeys)].sort();
  const sessionSecretEnv = params.sessionSecretEnv ?? {};
  const actualSecretKeys = Object.keys(sessionSecretEnv).sort();
  if (
    expectedSecretKeys.length !== actualSecretKeys.length ||
    expectedSecretKeys.some((key, index) => key !== actualSecretKeys[index])
  ) {
    throw new Error(
      "session credentials required by the persisted runtime host are unavailable",
    );
  }
  return {
    ...request,
    ...(actualSecretKeys.length > 0 ? { sessionSecretEnv } : {}),
  };
}

/** Recreate only the exact generation encoded in a persisted launch recipe. */
export async function recreateAgentWorkflowHostGeneration(params: {
  agentAppId: string;
  sandboxName: string;
  launchSpec: Record<string, unknown>;
  sessionSecretEnv?: Record<string, string> | null;
  traceContext?: TraceContext | null;
}): Promise<void> {
  const baseUrl = sandboxExecutionApiUrl();
  if (!baseUrl) {
    throw new Error("SANDBOX_EXECUTION_API_URL is required to recover a host");
  }
  const token =
    env.SANDBOX_EXECUTION_API_TOKEN ??
    env.HOST_EXECUTION_API_TOKEN ??
    process.env.SANDBOX_EXECUTION_API_TOKEN ??
    process.env.HOST_EXECUTION_API_TOKEN ??
    "";
  const requestBody = parseAgentWorkflowHostLaunchSpec(params);
  const traceHeaders: Record<string, string> = {};
  if (params.traceContext?.traceparent) {
    traceHeaders.traceparent = params.traceContext.traceparent;
  }
  if (params.traceContext?.tracestate) {
    traceHeaders.tracestate = params.traceContext.tracestate;
  }
  if (params.traceContext?.baggage) {
    traceHeaders.baggage = params.traceContext.baggage;
  }
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
    throw new Error(
      typeof body.detail === "string"
        ? body.detail
        : `agent workflow host recovery failed with HTTP ${response.status}`,
    );
  }
  if (
    body.agentAppId !== params.agentAppId ||
    body.sandboxName !== params.sandboxName
  ) {
    throw new Error(
      "agent workflow host recovery returned a different generation",
    );
  }
}

/**
 * Promote an exact provisional host generation only after its runtime target is
 * durably published. The provider verifies every identity component and owns
 * the final lifetime patch; retries are idempotent.
 */
export async function activateAgentWorkflowHostGeneration(params: {
  agentAppId: string;
  sandboxName: string;
}): Promise<void> {
  const baseUrl = sandboxExecutionApiUrl();
  if (!baseUrl) {
    throw new Error("SANDBOX_EXECUTION_API_URL is required to activate a host");
  }
  const token =
    env.SANDBOX_EXECUTION_API_TOKEN ??
    env.HOST_EXECUTION_API_TOKEN ??
    process.env.SANDBOX_EXECUTION_API_TOKEN ??
    process.env.HOST_EXECUTION_API_TOKEN ??
    "";
  const response = await fetch(
    `${baseUrl}/api/v1/agent-workflow-hosts/${encodeURIComponent(params.agentAppId)}/activate`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        sandboxName: params.sandboxName,
        generation: params.agentAppId,
      }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new AgentWorkflowHostActivationError(
      response.status,
      `agent workflow host activation failed (${response.status}): ${detail.slice(0, 200)}`,
    );
  }
}

async function probeAgentWorkflowHostAppReadyOnce(params: {
	agentAppId: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}): Promise<AgentWorkflowHostAppProbeAttempt> {
	try {
		const pod = await getAgentWorkflowHostPod(params.agentAppId);
		if (!pod) return { ready: false, error: "pod not found" };
		const baseUrl = `http://${pod.podIP}:8002`;
		const res = await (params.fetchImpl ?? fetch)(`${baseUrl}/readyz`, {
			method: "GET",
			signal: AbortSignal.timeout(Math.max(1, params.timeoutMs ?? 1_500)),
		});
		if (res.ok) {
			return {
				ready: true,
				result: {
					ok: true,
					attempts: 1,
					status: res.status,
					baseUrl,
					podName: pod.name,
					podIP: pod.podIP,
				},
			};
		}
		const text = await res.text().catch(() => "");
		return {
			ready: false,
			error: `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
		};
	} catch (err) {
		return {
			ready: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Check one time whether an existing workflow-host app is usable. This is the
 * non-blocking existence/readiness probe for adopt-or-provision decisions; use
 * `waitForAgentWorkflowHostAppReady` only after provisioning has been requested.
 */
export async function probeAgentWorkflowHostAppReady(params: {
	agentAppId: string;
	fetchImpl?: typeof fetch;
	probeTimeoutMs?: number;
}): Promise<AgentWorkflowHostAppReadyResult | null> {
	const attempt = await probeAgentWorkflowHostAppReadyOnce({
		...params,
		timeoutMs: params.probeTimeoutMs,
	});
	return attempt.ready ? attempt.result : null;
}

export async function waitForAgentWorkflowHostAppReady(params: {
	agentAppId: string;
	timeoutSeconds?: number;
	pollMs?: number;
	fetchImpl?: typeof fetch;
	probeTimeoutMs?: number;
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
		const attempt = await probeAgentWorkflowHostAppReadyOnce({
			agentAppId: params.agentAppId,
			fetchImpl,
			timeoutMs: Math.min(
				Math.max(1, params.probeTimeoutMs ?? 1_500),
				Math.max(1, deadline - Date.now()),
			),
		});
		if (attempt.ready) {
			return { ...attempt.result, attempts };
		}
		lastError = attempt.error;

		if (Date.now() > deadline) break;
		await new Promise((resolve) =>
			setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))),
		);
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

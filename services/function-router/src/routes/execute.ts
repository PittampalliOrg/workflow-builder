/**
 * Execute Route
 *
 * Routes function execution requests to the appropriate service:
 * - Knative Services (fn-openai, fn-slack, etc.) via direct HTTP to in-cluster services
 * - function-runner via Dapr service invocation for builtin fallback
 *
 * This route also pre-fetches credentials from Dapr secret store
 * to pass along to functions, with audit logging for compliance.
 *
 * Includes timing breakdown for performance analysis:
 * - credentialFetchMs: Time to resolve credentials
 * - routingMs: Time to resolve Knative function URL
 * - executionMs: Time for the actual function call
 * - wasColdStart: Detected based on response time anomalies
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { DaprClient, HttpMethod } from "@dapr/dapr";
import {
  context,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Agent as UndiciAgent, Pool } from "undici";
import { z } from "zod";

const longRunningAgent = new UndiciAgent({
  factory: (origin, opts) =>
    new Pool(origin, { ...opts, bodyTimeout: 0, headersTimeout: 0 }),
});
import {
  fetchCredentialsWithAudit,
  logCredentialReferenceForward,
} from "../core/credential-service.js";
import { resolveCodeFunctionExecution } from "../core/code-functions.js";
import {
  setSpanInput,
  setSpanInputOnSpan,
  setSpanOutput,
  setSpanOutputOnSpan,
} from "../observability/content.js";
import {
  logExecutionComplete,
  logExecutionStart,
  type TimingBreakdown,
} from "../core/execution-logger.js";
import {
  getResponseTimeAverage,
  recordResponseTime,
  resolveOpenFunctionUrl,
} from "../core/openfunction-resolver.js";
import {
  ensureGiteaPublishRepository,
  resolveCloneRepository,
} from "../core/gitea-repository.js";
import { apPieceServiceName, lookupFunction } from "../core/registry.js";
import {
  bindWorkflowSessionContext,
  buildWorkflowSessionId,
  sessionIdFromHeaders,
  workflowActivityContextFromHeaders,
} from "../observability/workflow-session.js";
import type {
  ExecuteRequest,
  ExecuteResponse,
  OpenFunctionRequest,
} from "../core/types.js";

const DAPR_HOST = process.env.DAPR_HOST || "localhost";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";
const HTTP_TIMEOUT_MS = Number.parseInt(
  process.env.HTTP_TIMEOUT_MS || "60000",
  10,
);
const WORKFLOW_BUILDER_URL =
  process.env.WORKFLOW_BUILDER_URL ||
  "http://workflow-builder.workflow-builder.svc.cluster.local:3000";
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || "";
const PREVIEW_ACTION_INTERNAL_TOKEN =
  process.env.PREVIEW_ACTION_INTERNAL_TOKEN?.trim() || "";
const PREVIEW_DEVELOPMENT_PROXY_TIMEOUT_MS = 90_000;
const DEV_PREVIEW_PROXY_TIMEOUT_MS = 15 * 60_000;
const AGENT_HTTP_TIMEOUT_BUFFER_MS = 30_000;
const MIN_AGENT_HTTP_TIMEOUT_MS = 90_000;
const MAX_AGENT_HTTP_TIMEOUT_MS = 7_200_000;
const DEFAULT_WORKSPACE_UTILITY_TIMEOUT_MS = 30_000;
const DEFAULT_WORKSPACE_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_WORKSPACE_CLONE_TIMEOUT_MS = 300_000;
const MAX_WORKSPACE_UTILITY_TIMEOUT_MS = 3_600_000;
const MAX_WORKSPACE_MATERIALIZE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_WORKSPACE_MATERIALIZE_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_WORKSPACE_PROFILE_TIMEOUT_MS = Math.max(
  300_000,
  Number.parseInt(
    process.env.MAX_WORKSPACE_PROFILE_TIMEOUT_MS ||
      String(MAX_WORKSPACE_UTILITY_TIMEOUT_MS),
    10,
  ) || MAX_WORKSPACE_UTILITY_TIMEOUT_MS,
);
const BROWSER_CAPTURE_OVERHEAD_MS = 15_000;

// Cold start detection: if response time is > 3x average, likely a cold start
const COLD_START_MULTIPLIER = 3;

function shouldUseDaprInvocation(appId: string): boolean {
  return appId.includes(".");
}

function daprInvocationBaseUrl(appId: string): string {
  return `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/invoke/${encodeURIComponent(appId)}/method`;
}

// Request body schema using Zod
const ExecuteRequestSchema = z.object({
  function_id: z.string().optional(),
  function_slug: z.string().optional(),
  execution_id: z.string().min(1),
  workflow_id: z.string().min(1),
  node_id: z.string().min(1),
  node_name: z.string().min(1),
  input: z.record(z.string(), z.unknown()).default({}),
  node_outputs: z
    .record(
      z.string(),
      z.object({
        label: z.string(),
        data: z.unknown(),
      }),
    )
    .optional(),
  integration_id: z.string().nullable().optional(),
  integrations: z
    .record(z.string(), z.record(z.string(), z.string()))
    .nullable()
    .optional(),
  db_execution_id: z.string().nullable().optional(),
  connection_external_id: z.string().nullable().optional(),
  ap_project_id: z.string().nullable().optional(),
  ap_platform_id: z.string().nullable().optional(),
  // AP durability contract (orchestrator → piece-runtime passthrough)
	idempotency_key: z.string().min(1).max(512).nullable().optional(),
  execution_type: z.enum(["BEGIN", "RESUME"]).optional(),
  resume_payload: z.unknown().optional(),
  skip_idempotency_gate: z.boolean().optional(),
  _otel: z.record(z.string(), z.unknown()).optional(),
});

function parseConnectionExternalIdFromAuthTemplate(
  auth: unknown,
): string | undefined {
  if (typeof auth !== "string") {
    return undefined;
  }
  const trimmed = auth.trim();
  if (!trimmed) {
    return undefined;
  }

  const match = trimmed.match(/\{\{connections\[['"]([^'"]+)['"]\]\}\}/);
  if (match?.[1]) {
    return match[1];
  }

  // Back-compat: some callers may pass the external ID directly.
  if (!trimmed.includes("{{") && !trimmed.includes("}}")) {
    return trimmed;
  }

  return undefined;
}

type MastraToolResponse = {
  success?: unknown;
  toolId?: unknown;
  result?: unknown;
  plan?: unknown;
  error?: unknown;
  workflowId?: unknown;
  workflow_id?: unknown;
  status?: unknown;
  message?: unknown;
};

function isPendingApprovalAgentResult(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const plannerStatus =
    typeof value.plannerStatus === "string"
      ? value.plannerStatus.trim().toLowerCase()
      : "";
  const status =
    typeof value.status === "string" ? value.status.trim().toLowerCase() : "";
  return (
    typeof value.artifactRef === "string" ||
    isPlainObject(value.approvalPayload) ||
    plannerStatus === "awaiting_review" ||
    status === "awaiting_approval"
  );
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resolveAgentHttpTimeoutMs(timeoutMinutes: unknown): number {
  const parsedTimeoutMinutes = asNumber(timeoutMinutes) ?? 30;
  const requestedTimeoutMs =
    Math.max(parsedTimeoutMinutes, 1) * 60_000 + AGENT_HTTP_TIMEOUT_BUFFER_MS;
  return Math.min(
    Math.max(requestedTimeoutMs, MIN_AGENT_HTTP_TIMEOUT_MS),
    MAX_AGENT_HTTP_TIMEOUT_MS,
  );
}

function clampTimeoutMs(
  value: number,
  {
    min,
    max,
  }: {
    min: number;
    max: number;
  },
): number {
  return Math.min(Math.max(value, min), max);
}

export function resolveWorkspaceUtilityTimeoutMs(input: {
  toolId: string;
  timeoutMs: unknown;
  commandTimeoutMs: unknown;
}): number {
  const explicitTimeoutMs = asNumber(input.timeoutMs);
  const explicitCommandTimeoutMs = asNumber(input.commandTimeoutMs);

  if (input.toolId === "clone") {
    return clampTimeoutMs(
      explicitTimeoutMs ?? DEFAULT_WORKSPACE_CLONE_TIMEOUT_MS,
      { min: 30_000, max: MAX_WORKSPACE_UTILITY_TIMEOUT_MS },
    );
  }

  if (input.toolId === "command") {
    return clampTimeoutMs(
      explicitTimeoutMs ??
        explicitCommandTimeoutMs ??
        DEFAULT_WORKSPACE_COMMAND_TIMEOUT_MS,
      { min: 10_000, max: MAX_WORKSPACE_UTILITY_TIMEOUT_MS },
    );
  }

  if (input.toolId === "profile") {
    return clampTimeoutMs(
      explicitTimeoutMs ??
        explicitCommandTimeoutMs ??
        DEFAULT_WORKSPACE_UTILITY_TIMEOUT_MS,
      { min: 10_000, max: MAX_WORKSPACE_PROFILE_TIMEOUT_MS },
    );
  }

  return clampTimeoutMs(
    explicitTimeoutMs ?? DEFAULT_WORKSPACE_UTILITY_TIMEOUT_MS,
    { min: 10_000, max: MAX_WORKSPACE_UTILITY_TIMEOUT_MS },
  );
}

function isNoFileChangeReviewResult(
  pluginId: string,
  toolId: string,
  parsedMastra: MastraToolResponse | undefined,
): boolean {
  if (pluginId !== "workspace" || toolId !== "command" || !parsedMastra) {
    return false;
  }
  if (!isPlainObject(parsedMastra.result)) {
    return false;
  }
  const nested = parsedMastra.result;
  const nestedExitCode =
    asNumber(nested.exitCode) ?? asNumber(nested.exit_code);
  if (nestedExitCode !== 2) {
    return false;
  }
  const text = [
    typeof nested.stdout === "string" ? nested.stdout : "",
    typeof nested.stderr === "string" ? nested.stderr : "",
    typeof parsedMastra.error === "string" ? parsedMastra.error : "",
  ]
    .join("\n")
    .toLowerCase();
  return text.includes("no file changes detected after durable run");
}

function getMastraNestedFailure(
  pluginId: string,
  toolId: string,
  parsedMastra: MastraToolResponse | undefined,
): string | undefined {
  if (!parsedMastra || !isPlainObject(parsedMastra.result)) {
    return undefined;
  }
  if (isNoFileChangeReviewResult(pluginId, toolId, parsedMastra)) {
    return undefined;
  }

  const nested = parsedMastra.result;
  const nestedSuccess =
    typeof nested.success === "boolean" ? nested.success : undefined;
  const nestedExitCode =
    asNumber(nested.exitCode) ?? asNumber(nested.exit_code);
  const nestedError =
    typeof nested.error === "string"
      ? nested.error
      : typeof nested.stderr === "string" && nested.stderr.trim()
        ? nested.stderr
        : typeof nested.stdout === "string" && nested.stdout.trim()
          ? nested.stdout
          : undefined;

  if (nestedSuccess === false) {
    return nestedError || `Tool "${toolId}" failed`;
  }

  if (nestedExitCode !== undefined && nestedExitCode !== 0) {
    return (
      nestedError || `Tool "${toolId}" failed with exit code ${nestedExitCode}`
    );
  }

  return undefined;
}

function parseJsonResponse(responseText: string): unknown {
  if (!responseText) {
    return null;
  }
  try {
    return JSON.parse(responseText) as unknown;
  } catch {
    return null;
  }
}

const dispatchTracer = trace.getTracer("function-router.dispatch");
const requestServerSpans = new WeakMap<object, Span>();

type DispatchRequestInit = Omit<RequestInit, "dispatcher"> & {
  dispatcher?: unknown;
};

function payloadForSpan(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  return parseJsonResponse(value) ?? value;
}

function urlPath(value: string): string | undefined {
  try {
    return new URL(value).pathname;
  } catch {
    return undefined;
  }
}

function urlHost(value: string): string | undefined {
  try {
    return new URL(value).host;
  } catch {
    return undefined;
  }
}

function setActiveHttpRouteAttributes(
  path: string,
  attributes: Record<string, string | number | boolean | undefined> = {},
): void {
  setHttpRouteAttributesOnSpan(trace.getActiveSpan(), path, attributes);
}

function setHttpRouteAttributesOnSpan(
  span: Span | undefined,
  path: string,
  attributes: Record<string, string | number | boolean | undefined> = {},
): void {
  if (!span) return;
  try {
    span.setAttribute("http.route", path);
    span.setAttribute("http.target", path);
    span.setAttribute("url.path", path);
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) {
        span.setAttribute(key, value);
      }
    }
  } catch {
    // Observability must never break request handling.
  }
}

function rememberRequestServerSpan(request: FastifyRequest): void {
  const span = trace.getActiveSpan();
  if (span) {
    requestServerSpans.set(request.raw, span);
  }
}

function spanTargetsForRequest(request: FastifyRequest): Span[] {
  const targets = new Set<Span>();
  const active = trace.getActiveSpan();
  const server = requestServerSpans.get(request.raw);
  if (active) targets.add(active);
  if (server) targets.add(server);
  return [...targets];
}

function executeRequestForSpan(body: ExecuteRequest): Record<string, unknown> {
  const functionSlug = body.function_slug ?? body.function_id ?? "";
  return {
    function_slug: functionSlug,
    execution_id: body.execution_id,
    db_execution_id: body.db_execution_id ?? undefined,
    workflow_id: body.workflow_id,
    node_id: body.node_id,
    node_name: body.node_name,
    input: workspaceMaterializeInputForSpan(functionSlug, body.input),
    node_outputs: body.node_outputs,
    connection_external_id: body.connection_external_id ?? undefined,
    ap_project_id: body.ap_project_id ?? undefined,
    ap_platform_id: body.ap_platform_id ?? undefined,
  };
}

function mutableHeadersFrom(input: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!input) return headers;

  if (typeof Headers !== "undefined" && input instanceof Headers) {
    input.forEach((value, key) => {
      headers[key] = value;
    });
    return headers;
  }

  if (Array.isArray(input)) {
    for (const entry of input) {
      if (Array.isArray(entry) && entry.length >= 2) {
        headers[String(entry[0])] = String(entry[1]);
      }
    }
    return headers;
  }

  if (typeof input === "object") {
    for (const [key, value] of Object.entries(
      input as Record<string, unknown>,
    )) {
      if (typeof value === "string") {
        headers[key] = value;
      } else if (Array.isArray(value)) {
        headers[key] = value.map(String).join(",");
      } else if (value != null) {
        headers[key] = String(value);
      }
    }
  }

  return headers;
}

async function postJsonWithContentTrace(
  targetUrl: string,
  init: DispatchRequestInit,
  attributes: Record<string, string | number | boolean | undefined>,
  tracePayload?: unknown,
): Promise<{
  httpResponse: Response;
  responseText: string;
}> {
  const path = urlPath(targetUrl);
  const span = dispatchTracer.startSpan(`POST ${path ?? targetUrl}`, {
    kind: SpanKind.CLIENT,
    attributes: {
      "http.request.method": "POST",
      "http.method": "POST",
      "url.full": targetUrl,
      "http.url": targetUrl,
      ...(path ? { "url.path": path, "http.target": path } : {}),
      ...(urlHost(targetUrl) ? { "server.address": urlHost(targetUrl) } : {}),
      ...Object.fromEntries(
        Object.entries(attributes).filter((entry) => entry[1] !== undefined),
      ),
    },
  });

  return await context.with(trace.setSpan(context.active(), span), async () => {
    setSpanInputOnSpan(
      span,
      tracePayload === undefined ? payloadForSpan(init.body) : tracePayload,
    );
    const headers = mutableHeadersFrom(init.headers);
    propagation.inject(context.active(), headers);
    const spanContext = span.spanContext();
    headers.traceparent = `00-${spanContext.traceId}-${spanContext.spanId}-${spanContext.traceFlags
      .toString(16)
      .padStart(2, "0")}`;
    try {
      const httpResponse = await fetch(targetUrl, {
        ...init,
        headers,
      } as RequestInit);
      span.setAttribute("http.response.status_code", httpResponse.status);
      span.setAttribute("http.status_code", httpResponse.status);
      const responseText = await httpResponse.text();
      setSpanOutputOnSpan(span, responseText);
      span.setStatus({
        code: httpResponse.ok ? SpanStatusCode.OK : SpanStatusCode.ERROR,
        message: httpResponse.ok ? undefined : `HTTP ${httpResponse.status}`,
      });
      return { httpResponse, responseText };
    } catch (error) {
      setSpanOutputOnSpan(span, dispatchErrorPayload(error, path));
      span.recordException(error as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

export function dispatchErrorPayload(
  error: unknown,
  targetPath?: string | null,
): Record<string, unknown> {
  const errorRecord =
    error instanceof Error
      ? {
          name: error.name,
          message: error.message,
        }
      : {
          name: typeof error,
          message: String(error),
        };
  return {
    success: false,
    error: errorRecord.message,
    errorType: errorRecord.name,
    ...(targetPath ? { targetPath } : {}),
  };
}

/**
 * goal/plan — deterministic goal-authoring activity (the workflow PLAN node).
 * The BFF owns the LLM keys + the single `planGoal` implementation, so the
 * router just proxies to its internal endpoint (same boundary as the evaluator
 * credential path). Returns an ExecuteResponse whose `data` is the plan result
 * { goalSpec, rationale, lint } — consumed downstream as `${ .plan.data.goalSpec }`.
 */
async function executeGoalPlan(
  input: Record<string, unknown>,
): Promise<ExecuteResponse> {
  const started = Date.now();
  // `fromText` mode: a planner AGENT already authored + validated the goalSpec;
  // the BFF just extracts/normalizes its free-text output (no LLM call).
  const fromText =
    typeof input.fromText === "string" ? input.fromText.trim() : "";
  const intent =
    typeof input.intent === "string"
      ? input.intent.trim()
      : typeof input.prompt === "string"
        ? input.prompt.trim()
        : "";
  if (!fromText && !intent) {
    return {
      success: false,
      data: {},
      error:
        "goal/plan: missing required `intent` (or `prompt`) or `fromText`.",
      duration_ms: Date.now() - started,
    } as ExecuteResponse;
  }
  const payload: Record<string, unknown> = fromText ? { fromText } : { intent };
  if (isPlainObject(input.context)) payload.context = input.context;
  if (typeof input.model === "string" && input.model.trim()) {
    payload.model = input.model.trim();
  }

  try {
    const res = await fetch(`${WORKFLOW_BUILDER_URL}/api/internal/goals/plan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Token": INTERNAL_API_TOKEN,
      },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    const parsed = parseJsonResponse(text);
    if (!res.ok) {
      const message =
        isPlainObject(parsed) && typeof parsed.error === "string"
          ? parsed.error
          : `planGoal failed (${res.status})`;
      return {
        success: false,
        data: {},
        error: message,
        duration_ms: Date.now() - started,
      } as ExecuteResponse;
    }
    return {
      success: true,
      data: isPlainObject(parsed) ? parsed : {},
      duration_ms: Date.now() - started,
    } as ExecuteResponse;
  } catch (err) {
    return {
      success: false,
      data: {},
      error: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - started,
    } as ExecuteResponse;
  }
}

/**
 * session/spawn — workflow → interactive dev-session handoff (P3). Proxies to the
 * BFF, which creates + starts a persistent interactive coding-agent session bound
 * to the execution's shared workspace. Returns `{ sessionId, url }` (consumed
 * downstream as `${ .handoff.sessionId }` / `.handoff.url`).
 */
async function executeSessionSpawn(
  input: Record<string, unknown>,
  trustedExecutionId?: string,
): Promise<ExecuteResponse> {
  const started = Date.now();
  // SW-1.0 nodes pass `executionId: ${ .runtime.executionId }`, but a dynamic
  // script has no execution-id global, so fall back to the trusted activity
  // context (body.db_execution_id ?? body.execution_id) the router already
  // holds — same source workspace/* and dev/preview use.
  const executionId =
    (typeof input.executionId === "string" && input.executionId.trim()) ||
    (trustedExecutionId ?? "").trim();
  const instructions =
    typeof input.instructions === "string" ? input.instructions : "";
  if (!executionId || !instructions.trim()) {
    return {
      success: false,
      data: {},
      error: "session/spawn: requires `executionId` and `instructions`.",
      duration_ms: Date.now() - started,
    } as ExecuteResponse;
  }
  const payload: Record<string, unknown> = { instructions };
  if (typeof input.agentSlug === "string") payload.agentSlug = input.agentSlug;
  if (typeof input.title === "string") payload.title = input.title;
  try {
    const res = await fetch(
      `${WORKFLOW_BUILDER_URL}/api/internal/workflows/executions/${encodeURIComponent(
        executionId,
      )}/interactive-session`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Token": INTERNAL_API_TOKEN,
        },
        body: JSON.stringify(payload),
      },
    );
    const text = await res.text();
    const parsed = parseJsonResponse(text);
    if (!res.ok) {
      const message =
        isPlainObject(parsed) && typeof parsed.error === "string"
          ? parsed.error
          : `session/spawn failed (${res.status})`;
      return {
        success: false,
        data: {},
        error: message,
        duration_ms: Date.now() - started,
      } as ExecuteResponse;
    }
    return {
      success: true,
      data: isPlainObject(parsed) ? parsed : {},
      duration_ms: Date.now() - started,
    } as ExecuteResponse;
  } catch (err) {
    return {
      success: false,
      data: {},
      error: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - started,
    } as ExecuteResponse;
  }
}

type BrowserStartPreviewProxyRequest = Readonly<{
  executionId: string;
  path: string;
  body: Record<string, unknown>;
}>;

type BrowserStartPreviewRequestResult =
  | Readonly<{ ok: true; request: BrowserStartPreviewProxyRequest }>
  | Readonly<{ ok: false; error: string }>;

export function buildBrowserStartPreviewProxyRequest(input: {
  actionInput: Record<string, unknown>;
  dbExecutionId: string | null | undefined;
  nodeId: string;
}): BrowserStartPreviewRequestResult {
  const executionId = optionalStringInput(input.dbExecutionId);
  if (!executionId) {
    return {
      ok: false,
      error:
        "browser/start-preview: missing trusted db_execution_id context; caller-supplied execution IDs are not accepted.",
    };
  }

  let args: Record<string, unknown>;
  try {
    ({ args } = parseMastraToolInput(input.actionInput, "start-preview"));
  } catch (cause) {
    return {
      ok: false,
      error:
        cause instanceof Error
          ? `browser/start-preview: ${cause.message}`
          : "browser/start-preview: invalid action input",
    };
  }

  const previewId =
    optionalStringInput(args.previewId) ??
    (input.nodeId ? `${executionId}-${input.nodeId}` : undefined) ??
    optionalStringInput(args.workspaceRef);

  return {
    ok: true,
    request: {
      executionId,
      path: `/api/internal/workflows/executions/${encodeURIComponent(executionId)}/sandbox-preview`,
      body: {
        previewId,
        repoPath: args.repoPath,
        installCommand: args.installCommand,
        devServerCommand: args.devServerCommand,
        baseUrl: args.baseUrl,
        timeoutSeconds: args.timeoutSeconds,
      },
    },
  };
}

function canonicalBrowserPreviewResult(
  value: Record<string, unknown>,
  executionId: string,
  actionInput: Record<string, unknown>,
): Record<string, unknown> {
  const previewId = optionalStringInput(value.previewId);
  const proxyUrl = optionalStringInput(value.proxyUrl);
  const pageUrl = optionalStringInput(value.pageUrl);
  if (!previewId || !proxyUrl || !pageUrl) {
    throw new Error(
      "browser/start-preview: preview service did not return canonical previewId, proxyUrl, and pageUrl",
    );
  }
  let parsedProxyUrl: URL;
  try {
    parsedProxyUrl = new URL(proxyUrl);
  } catch {
    throw new Error(
      "browser/start-preview: preview service returned a non-canonical execution proxy URL",
    );
  }
  const expectedPath = `/api/workflows/executions/${encodeURIComponent(executionId)}/sandbox-preview/${encodeURIComponent(previewId)}/`;
  if (
    (parsedProxyUrl.protocol !== "http:" &&
      parsedProxyUrl.protocol !== "https:") ||
    parsedProxyUrl.pathname !== expectedPath
  ) {
    throw new Error(
      "browser/start-preview: preview service returned a non-canonical execution proxy URL",
    );
  }

  let args: Record<string, unknown> = {};
  try {
    ({ args } = parseMastraToolInput(actionInput, "start-preview"));
  } catch {
    // The request builder already validated this input.
  }
  const copyString = (key: string) => {
    const text = optionalStringInput(value[key]);
    return text ? { [key]: text } : {};
  };
  return {
    success: true,
    executionId,
    previewId,
    proxyUrl,
    pageUrl,
    ...copyString("workspaceRef"),
    ...copyString("sandboxName"),
    ...copyString("rootPath"),
    ...copyString("workingDir"),
    ...copyString("provider"),
    ...copyString("status"),
    ...copyString("startedAt"),
    ...copyString("workingDirectory"),
    ...copyString("resolvedAppPath"),
    ...copyString("appPathSource"),
    ...(isPlainObject(value.sandbox) ? { sandbox: value.sandbox } : {}),
    ...(optionalStringInput(args.repoPath)
      ? { requestedRepoPath: optionalStringInput(args.repoPath) }
      : {}),
    ...(optionalStringInput(args.baseUrl)
      ? { requestedBaseUrl: optionalStringInput(args.baseUrl) }
      : {}),
    ...(optionalStringInput(args.devServerCommand)
      ? {
          requestedDevServerCommand: optionalStringInput(
            args.devServerCommand,
          ),
        }
      : {}),
    ...(optionalStringInput(args.installCommand)
      ? { requestedInstallCommand: optionalStringInput(args.installCommand) }
      : {}),
  };
}

export async function executeBrowserStartPreviewAction(
  input: {
    actionInput: Record<string, unknown>;
    dbExecutionId: string | null | undefined;
    nodeId: string;
  },
  options: Readonly<{
    fetchImpl?: typeof fetch;
    previewActionToken?: string;
    workflowBuilderUrl?: string;
    timeoutMs?: number;
  }> = {},
): Promise<ExecuteResponse> {
  const started = Date.now();
  const built = buildBrowserStartPreviewProxyRequest(input);
  if (!built.ok) {
    return {
      success: false,
      data: {},
      error: built.error,
      errorClass: "permanent",
      duration_ms: Date.now() - started,
    };
  }
  const previewActionToken =
    options.previewActionToken ?? PREVIEW_ACTION_INTERNAL_TOKEN;
  if (!previewActionToken) {
    return {
      success: false,
      data: {},
      error:
        "browser/start-preview: PREVIEW_ACTION_INTERNAL_TOKEN is not configured",
      errorClass: "permanent",
      duration_ms: Date.now() - started,
    };
  }

  try {
    const { args } = parseMastraToolInput(input.actionInput, "start-preview");
    const response = await (options.fetchImpl ?? fetch)(
      `${options.workflowBuilderUrl ?? WORKFLOW_BUILDER_URL}${built.request.path}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Preview-Action-Token": previewActionToken,
        },
        body: JSON.stringify(built.request.body),
        signal: AbortSignal.timeout(
          options.timeoutMs ??
            resolveWorkspaceUtilityTimeoutMs({
              toolId: "start-preview",
              timeoutMs: args.timeoutMs,
              commandTimeoutMs: undefined,
            }) + BROWSER_CAPTURE_OVERHEAD_MS,
        ),
      },
    );
    const parsed = parseJsonResponse(await response.text());
    const data = isPlainObject(parsed) ? parsed : {};
    if (!response.ok || data.success === false) {
      return {
        success: false,
        data,
        error:
          typeof data.error === "string"
            ? data.error
            : `browser/start-preview failed (${response.status})`,
        errorClass: [408, 425, 429, 502, 503, 504].includes(response.status)
          ? "retryable"
          : "permanent",
        responseStatus: response.status,
        duration_ms: Date.now() - started,
      };
    }

    const result = canonicalBrowserPreviewResult(
      data,
      built.request.executionId,
      input.actionInput,
    );
    return {
      success: true,
      data: { toolId: "start-preview", result, ...result },
      responseStatus: response.status,
      duration_ms: Date.now() - started,
    };
  } catch (cause) {
    return {
      success: false,
      data: {},
      error: cause instanceof Error ? cause.message : String(cause),
      errorClass:
        cause instanceof TypeError ||
        (cause instanceof Error && cause.name === "TimeoutError")
          ? "retryable"
          : "permanent",
      responseStatus: 0,
      duration_ms: Date.now() - started,
    };
  }
}

export const PREVIEW_DEVELOPMENT_ACTION_SLUGS = [
	"preview/environment-launch",
	"preview/environment-status",
	"preview/workflow-start",
	"preview/workflow-status",
	"preview/workflow-signal",
	"preview/workflow-verify-promotion",
	"preview/environment-teardown",
	"preview/environment-teardown-status",
] as const;

export const PRIVILEGED_PREVIEW_ACTION_SLUGS = [
	...PREVIEW_DEVELOPMENT_ACTION_SLUGS,
	"dev/preview",
	"dev/preview-teardown",
	"dev/preview-snapshot",
	"dev/preview-promote",
	"dev/preview-acceptance",
	"dev/preview-build",
	"dev/preview-freeze",
] as const;

export type PreviewDevelopmentActionSlug = (typeof PREVIEW_DEVELOPMENT_ACTION_SLUGS)[number];

export function previewDevelopmentCallerAuthorized(
	provided: unknown,
	expected = PREVIEW_ACTION_INTERNAL_TOKEN,
): boolean {
	if (typeof provided !== "string" || !provided || !expected) return false;
	const actualBytes = Buffer.from(provided, "utf8");
	const expectedBytes = Buffer.from(expected, "utf8");
	return (
		actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
	);
}

export function previewActionRequestAuthorized(
	functionSlug: string,
	provided: unknown,
	expected = PREVIEW_ACTION_INTERNAL_TOKEN,
): boolean {
	return (
		!(PRIVILEGED_PREVIEW_ACTION_SLUGS as readonly string[]).includes(functionSlug) ||
		previewDevelopmentCallerAuthorized(provided, expected)
	);
}

type PreviewDevelopmentProxyRequest = Readonly<{
	path:
		| "/api/internal/preview-development/environment"
		| "/api/internal/preview-development/target";
	body: Record<string, unknown>;
	operationId: string;
}>;

type PreviewDevelopmentRequestResult =
	| Readonly<{ ok: true; request: PreviewDevelopmentProxyRequest }>
	| Readonly<{ ok: false; error: string }>;

const PREVIEW_NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const SHA256_REF = /^sha256:[0-9a-f]{64}$/;
const SIGNATURE = /^[0-9a-f]{64}$/;
const SAFE_EXECUTION_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const SAFE_AGENT_SLUG = /^[a-z0-9][a-z0-9-]{0,127}$/;
const PROMOTION_RECEIPT_ID = /^pspr_[0-9a-f]{64}$/;
const MAX_DIFF_SCOPE_PREFIXES = 128;
const MAX_DIFF_SCOPE_PREFIX_CHARS = 512;

function exactObjectKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function parsePreviewDevelopmentTarget(value: unknown): Record<string, string> | null {
	if (!isPlainObject(value)) return null;
	const keys = [
		"previewName",
		"environmentRequestId",
		"platformRevision",
		"sourceRevision",
		"catalogDigest",
	] as const;
	if (
		Object.keys(value).length !== keys.length ||
		!exactObjectKeys(value, keys) ||
		typeof value.previewName !== "string" ||
		!PREVIEW_NAME.test(value.previewName) ||
		typeof value.environmentRequestId !== "string" ||
		value.environmentRequestId.length < 1 ||
		value.environmentRequestId.length > 256 ||
		typeof value.platformRevision !== "string" ||
		!GIT_SHA.test(value.platformRevision) ||
		typeof value.sourceRevision !== "string" ||
		!GIT_SHA.test(value.sourceRevision) ||
		typeof value.catalogDigest !== "string" ||
		!SHA256_REF.test(value.catalogDigest)
	) {
		return null;
	}
	return Object.fromEntries(keys.map((key) => [key, value[key] as string]));
}

function parsePreviewTeardownTicket(
	value: unknown,
	target: Record<string, string>,
): Record<string, string> | null {
	if (!isPlainObject(value)) return null;
	const keys = ["name", "environmentUid", "requestId", "sourceRevision", "signature"] as const;
	if (
		Object.keys(value).length !== keys.length ||
		!exactObjectKeys(value, keys) ||
		value.name !== target.previewName ||
		typeof value.environmentUid !== "string" ||
		value.environmentUid.length < 1 ||
		value.environmentUid.length > 128 ||
		value.requestId !== target.environmentRequestId ||
		value.sourceRevision !== target.sourceRevision ||
		typeof value.signature !== "string" ||
		!SIGNATURE.test(value.signature)
	) {
		return null;
	}
	return Object.fromEntries(keys.map((key) => [key, value[key] as string]));
}

function parseServices(value: unknown): string[] | null {
	if (!Array.isArray(value) || value.length < 1 || value.length > 16) return null;
	const services: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (typeof item !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(item) || seen.has(item)) {
			return null;
		}
		seen.add(item);
		services.push(item);
	}
	return services;
}

export function previewDevelopmentOperationId(input: {
	parentExecutionId: string;
	commandKind: string;
	idempotencyKey?: string | null;
	actionSlug: PreviewDevelopmentActionSlug;
}): string {
	const idempotencyKey =
		input.idempotencyKey?.trim() || `${input.parentExecutionId}:${input.actionSlug}`;
	const digest = createHash("sha256")
		.update(
			`preview-development/v1\0${input.parentExecutionId}\0${input.commandKind}\0${idempotencyKey}`,
		)
		.digest("hex");
	return `pdt-${input.commandKind}-${digest}`;
}

export function buildPreviewDevelopmentProxyRequest(input: {
	actionSlug: PreviewDevelopmentActionSlug;
	actionInput: Record<string, unknown>;
	dbExecutionId: string | null | undefined;
	idempotencyKey?: string | null;
}): PreviewDevelopmentRequestResult {
	const parentExecutionId = input.dbExecutionId?.trim() ?? "";
	if (!SAFE_EXECUTION_ID.test(parentExecutionId)) {
		return {
			ok: false,
			error: `${input.actionSlug}: missing trusted db_execution_id`,
		};
	}
	if (
		input.idempotencyKey !== undefined &&
		input.idempotencyKey !== null &&
		(input.idempotencyKey.trim().length < 1 ||
			input.idempotencyKey.length > 512 ||
			/[\u0000-\u001f\u007f]/.test(input.idempotencyKey))
	) {
		return {
			ok: false,
			error: `${input.actionSlug}: invalid idempotency key`,
		};
	}

	const actionInput = input.actionInput;
	let commandKind: string;
	let path: PreviewDevelopmentProxyRequest["path"];
	let command: Record<string, unknown>;
	let target: Record<string, string> | undefined;

	if (input.actionSlug === "preview/environment-launch") {
		if (
			!exactObjectKeys(actionInput, [
				"environmentName",
				"services",
				"ttlHours",
				"retainAfterCompletion",
			]) ||
			typeof actionInput.environmentName !== "string" ||
			!PREVIEW_NAME.test(actionInput.environmentName) ||
			!Number.isInteger(actionInput.ttlHours) ||
			(actionInput.ttlHours as number) < 2 ||
			(actionInput.ttlHours as number) > 24 ||
			(actionInput.retainAfterCompletion !== undefined &&
				typeof actionInput.retainAfterCompletion !== "boolean")
		) {
			return { ok: false, error: `${input.actionSlug}: invalid launch input` };
		}
		const services = parseServices(actionInput.services);
		if (!services) {
			return { ok: false, error: `${input.actionSlug}: invalid services` };
		}
		commandKind = "launch-environment";
		path = "/api/internal/preview-development/environment";
		command = {
			kind: commandKind,
			input: {
				environmentName: actionInput.environmentName,
				services,
				ttlHours: actionInput.ttlHours,
				retainAfterCompletion: actionInput.retainAfterCompletion === true,
			},
		};
	} else {
		const parsedTarget = parsePreviewDevelopmentTarget(actionInput.target);
		if (!parsedTarget) {
			return {
				ok: false,
				error: `${input.actionSlug}: invalid exact target tuple`,
			};
		}
		target = parsedTarget;
		if (input.actionSlug === "preview/environment-status") {
			if (!exactObjectKeys(actionInput, ["target"])) {
				return {
					ok: false,
					error: `${input.actionSlug}: unsupported input fields`,
				};
			}
			commandKind = "get-environment-status";
			path = "/api/internal/preview-development/environment";
			command = { kind: commandKind, target };
		} else if (input.actionSlug === "preview/workflow-start") {
			if (
				!exactObjectKeys(actionInput, [
					"target",
					"intent",
					"services",
					"agentSlug",
					"ttlHours",
					"retainAfterCompletion",
					"interactiveHandoff",
					"impactReview",
					"diffScope",
					"maxIterations",
				]) ||
				typeof actionInput.intent !== "string" ||
				actionInput.intent.trim().length < 1 ||
				actionInput.intent.length > 12_000 ||
				(actionInput.agentSlug !== undefined &&
					(typeof actionInput.agentSlug !== "string" ||
						!SAFE_AGENT_SLUG.test(actionInput.agentSlug))) ||
				(actionInput.ttlHours !== undefined &&
					(!Number.isInteger(actionInput.ttlHours) ||
						(actionInput.ttlHours as number) < 2 ||
						(actionInput.ttlHours as number) > 24)) ||
				(actionInput.retainAfterCompletion !== undefined &&
					typeof actionInput.retainAfterCompletion !== "boolean") ||
				(actionInput.interactiveHandoff !== undefined &&
					typeof actionInput.interactiveHandoff !== "boolean") ||
				(actionInput.impactReview !== undefined &&
					typeof actionInput.impactReview !== "boolean") ||
				(actionInput.diffScope !== undefined &&
					(!Array.isArray(actionInput.diffScope) ||
						actionInput.diffScope.length > MAX_DIFF_SCOPE_PREFIXES ||
						actionInput.diffScope.some(
							(prefix) =>
								typeof prefix !== "string" ||
								prefix.trim().length < 1 ||
								prefix.length > MAX_DIFF_SCOPE_PREFIX_CHARS ||
								/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(prefix),
						))) ||
				(actionInput.maxIterations !== undefined &&
					(!Number.isInteger(actionInput.maxIterations) ||
						(actionInput.maxIterations as number) < 1 ||
						(actionInput.maxIterations as number) > 3))
			) {
				return {
					ok: false,
					error: `${input.actionSlug}: invalid workflow input`,
				};
			}
			const services = parseServices(actionInput.services);
			if (!services) {
				return { ok: false, error: `${input.actionSlug}: invalid services` };
			}
			commandKind = "start-workflow";
			path = "/api/internal/preview-development/target";
			command = {
				kind: commandKind,
				target,
				input: {
					intent: actionInput.intent,
					services,
					...(actionInput.agentSlug !== undefined
						? { agentSlug: actionInput.agentSlug }
						: {}),
					keepPreview: "true",
					// Optional child controls forward only when present so the default
					// start payload stays byte-identical.
					...(actionInput.ttlHours !== undefined
						? { ttlHours: actionInput.ttlHours }
						: {}),
					...(actionInput.retainAfterCompletion !== undefined
						? { retainAfterCompletion: actionInput.retainAfterCompletion }
						: {}),
					...(actionInput.interactiveHandoff !== undefined
						? { interactiveHandoff: actionInput.interactiveHandoff }
						: {}),
					...(actionInput.impactReview !== undefined
						? { impactReview: actionInput.impactReview }
						: {}),
					...(actionInput.diffScope !== undefined
						? { diffScope: actionInput.diffScope }
						: {}),
					...(actionInput.maxIterations !== undefined
						? { maxIterations: actionInput.maxIterations }
						: {}),
				},
			};
		} else if (
			input.actionSlug === "preview/workflow-status" ||
			input.actionSlug === "preview/workflow-signal"
		) {
			const allowed =
				input.actionSlug === "preview/workflow-signal"
					? ["target", "executionId", "workflowSpecDigest", "action"]
					: ["target", "executionId", "workflowSpecDigest"];
			if (
				!exactObjectKeys(actionInput, allowed) ||
				typeof actionInput.executionId !== "string" ||
				actionInput.executionId.length < 1 ||
				actionInput.executionId.length > 256 ||
				typeof actionInput.workflowSpecDigest !== "string" ||
				!SHA256_REF.test(actionInput.workflowSpecDigest)
			) {
				return {
					ok: false,
					error: `${input.actionSlug}: invalid child identity`,
				};
			}
			commandKind =
				input.actionSlug === "preview/workflow-signal"
					? "signal-workflow"
					: "get-workflow-status";
			path = "/api/internal/preview-development/target";
			command = {
				kind: commandKind,
				target,
				executionId: actionInput.executionId,
				workflowSpecDigest: actionInput.workflowSpecDigest,
			};
			if (input.actionSlug === "preview/workflow-signal") {
				if (
					actionInput.action !== "submit_preview_pr" &&
					actionInput.action !== "discard"
				) {
					return {
						ok: false,
						error: `${input.actionSlug}: invalid control action`,
					};
				}
				command.action = actionInput.action;
			}
		} else if (input.actionSlug === "preview/workflow-verify-promotion") {
			if (
				!exactObjectKeys(actionInput, [
					"target",
					"childExecutionId",
					"receiptId",
					"services",
				]) ||
				typeof actionInput.childExecutionId !== "string" ||
				!SAFE_EXECUTION_ID.test(actionInput.childExecutionId) ||
				typeof actionInput.receiptId !== "string" ||
				!PROMOTION_RECEIPT_ID.test(actionInput.receiptId)
			) {
				return {
					ok: false,
					error: `${input.actionSlug}: invalid promotion coordinates`,
				};
			}
			const services = parseServices(actionInput.services);
			if (!services) {
				return { ok: false, error: `${input.actionSlug}: invalid services` };
			}
			commandKind = "verify-promotion";
			path = "/api/internal/preview-development/target";
			command = {
				kind: commandKind,
				target,
				childExecutionId: actionInput.childExecutionId,
				receiptId: actionInput.receiptId,
				services,
			};
		} else if (input.actionSlug === "preview/environment-teardown") {
			if (!exactObjectKeys(actionInput, ["target"])) {
				return {
					ok: false,
					error: `${input.actionSlug}: unsupported input fields`,
				};
			}
			commandKind = "teardown-environment";
			path = "/api/internal/preview-development/environment";
			command = { kind: commandKind, target };
		} else {
			if (!exactObjectKeys(actionInput, ["target", "ticket"])) {
				return {
					ok: false,
					error: `${input.actionSlug}: unsupported input fields`,
				};
			}
			const ticket = parsePreviewTeardownTicket(actionInput.ticket, target);
			if (!ticket) {
				return {
					ok: false,
					error: `${input.actionSlug}: invalid teardown ticket`,
				};
			}
			commandKind = "get-environment-teardown-status";
			path = "/api/internal/preview-development/environment";
			command = { kind: commandKind, target, ticket };
		}
	}

	const operationId = previewDevelopmentOperationId({
		parentExecutionId,
		commandKind,
		idempotencyKey: input.idempotencyKey,
		actionSlug: input.actionSlug,
	});
	command.operationId = operationId;
	return {
		ok: true,
		request: {
			path,
			operationId,
			body: {
				parentExecutionId,
				command,
			},
		},
	};
}

export async function executePreviewDevelopmentAction(
	input: {
		actionSlug: PreviewDevelopmentActionSlug;
		actionInput: Record<string, unknown>;
		dbExecutionId: string | null | undefined;
		idempotencyKey?: string | null;
	},
	options: Readonly<{
		fetchImpl?: typeof fetch;
		previewActionToken?: string;
		timeoutMs?: number;
	}> = {},
): Promise<ExecuteResponse> {
	const started = Date.now();
	const built = buildPreviewDevelopmentProxyRequest(input);
	if (!built.ok) {
		return {
			success: false,
			data: {},
			error: built.error,
			errorClass: "permanent",
			duration_ms: Date.now() - started,
		};
	}
	const previewActionToken = options.previewActionToken ?? PREVIEW_ACTION_INTERNAL_TOKEN;
	if (!previewActionToken) {
		return {
			success: false,
			data: {},
			error: `${input.actionSlug}: PREVIEW_ACTION_INTERNAL_TOKEN is not configured`,
			errorClass: "permanent",
			duration_ms: Date.now() - started,
		};
	}
	try {
		const response = await (options.fetchImpl ?? fetch)(
			`${WORKFLOW_BUILDER_URL}${built.request.path}`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Preview-Action-Token": previewActionToken,
					"X-Idempotency-Key": built.request.operationId,
				},
				body: JSON.stringify(built.request.body),
				signal: AbortSignal.timeout(
					options.timeoutMs ?? PREVIEW_DEVELOPMENT_PROXY_TIMEOUT_MS,
				),
			},
		);
		const parsed = parseJsonResponse(await response.text());
		const data = isPlainObject(parsed) ? parsed : {};
		if (!response.ok || data.ok === false) {
			return {
				success: false,
				data,
				error:
					typeof data.error === "string"
						? data.error
						: `${input.actionSlug} failed (${response.status})`,
				errorClass: [408, 425, 429, 502, 503, 504].includes(response.status)
					? "retryable"
					: "permanent",
				responseStatus: response.status,
				duration_ms: Date.now() - started,
			};
		}
		return {
			success: true,
			data,
			responseStatus: response.status,
			duration_ms: Date.now() - started,
		};
	} catch (cause) {
		return {
			success: false,
			data: {},
			error: cause instanceof Error ? cause.message : String(cause),
			errorClass: "retryable",
			responseStatus: 0,
			duration_ms: Date.now() - started,
		};
	}
}

/**
 * dev/preview (ensure) + dev/preview-teardown — per-run ephemeral dev-server
 * Sandbox. The BFF owns the privileged sandbox-execution-api call (the agent
 * needs no kube creds), so the router just proxies to its internal endpoint
 * keyed only on the trusted `db_execution_id` activity context. `dev/preview`
 * returns the dev pod's in-cluster `url` (consumed downstream as
 * `${ .provision_preview.data.url }`).
 */
export function bindDevPreviewExecutionId(
  input: Record<string, unknown>,
  dbExecutionId: string | null | undefined,
): { ok: true; executionId: string } | { ok: false; error: string } {
  const executionId =
    typeof dbExecutionId === "string" ? dbExecutionId.trim() : "";
  if (!executionId) {
    return {
      ok: false,
      error:
        "dev/preview: missing trusted `db_execution_id` context; caller-supplied execution IDs are not accepted.",
    };
  }
  if (input.executionId !== undefined) {
    const requested =
      typeof input.executionId === "string" ? input.executionId.trim() : "";
    if (requested !== executionId) {
      return {
        ok: false,
        error:
          "dev/preview: input.executionId does not match trusted db_execution_id.",
      };
    }
  }
  return { ok: true, executionId };
}

const TRANSIENT_DEV_PREVIEW_STATUSES = new Set([408, 425, 429, 502, 503, 504]);

type DevPreviewProxyMode =
  | "ensure"
  | "teardown"
  | "snapshot"
  | "promote"
  | "acceptance"
  | "build"
  | "freeze";

function expectsDurableDevPreviewActivation(
  input: Record<string, unknown>,
  mode: DevPreviewProxyMode,
): boolean {
  return (
    mode === "ensure" &&
    input.mode === "preview-native" &&
    input.adopt !== false &&
    Array.isArray(input.services)
  );
}

function requestedDevPreviewServices(
  input: Record<string, unknown>,
): string[] | null {
  if (!Array.isArray(input.services) || input.services.length === 0)
    return null;
  const services: string[] = [];
  const seen = new Set<string>();
  for (const value of input.services) {
    if (typeof value !== "string" || value !== value.trim() || !value)
      return null;
    if (seen.has(value)) return null;
    seen.add(value);
    services.push(value);
  }
  return services;
}

function hasExactReadyDevPreviewServices(input: {
  data: Record<string, unknown>;
  executionId: string;
  requestedServices: readonly string[];
}): boolean {
  if (!Array.isArray(input.data.services)) return false;
  if (input.data.services.length !== input.requestedServices.length)
    return false;
  const requested = new Set(input.requestedServices);
  const received = new Set<string>();
  for (const value of input.data.services) {
    if (!isPlainObject(value) || typeof value.service !== "string")
      return false;
    const service = value.service;
    if (!requested.has(service) || received.has(service) || value.ok !== true) {
      return false;
    }
    if (!isPlainObject(value.info)) return false;
    const info = value.info;
    if (
      info.executionId !== input.executionId ||
      info.service !== service ||
      info.ready !== true ||
      typeof info.sandboxName !== "string" ||
      !info.sandboxName ||
      typeof info.podIP !== "string" ||
      !info.podIP ||
      typeof info.syncUrl !== "string" ||
      !info.syncUrl
    ) {
      return false;
    }
    received.add(service);
  }
  return received.size === requested.size;
}

export function classifyDevPreviewProxyResponse(input: {
  mode: DevPreviewProxyMode;
  requestInput: Record<string, unknown>;
  executionId: string;
  status: number;
  parsed: unknown;
  durationMs?: number;
}): ExecuteResponse {
  const data = isPlainObject(input.parsed) ? input.parsed : {};
  const duration_ms = input.durationMs ?? 0;
  const activationExpected = expectsDurableDevPreviewActivation(
    input.requestInput,
    input.mode,
  );

  if (activationExpected && input.status >= 200 && input.status < 300) {
    const requestedServices = requestedDevPreviewServices(input.requestInput);
    const phase = data.activationPhase;
    const batchId = typeof data.batchId === "string" ? data.batchId.trim() : "";
    const validBatchId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(batchId);
    const exactReadyServices =
      requestedServices !== null &&
      hasExactReadyDevPreviewServices({
        data,
        executionId: input.executionId,
        requestedServices,
      });
    const pending =
      input.status === 202 &&
      data.executionId === input.executionId &&
      data.ok === true &&
      data.complete === false &&
      data.pending === true &&
      (phase === "scheduled" || phase === "activating") &&
      validBatchId &&
      exactReadyServices;
    const active =
      input.status === 200 &&
      data.executionId === input.executionId &&
      data.ok === true &&
      data.complete === true &&
      data.pending === false &&
      phase === "active" &&
      validBatchId &&
      exactReadyServices;
    if (!pending && !active) {
      return {
        success: false,
        data,
        error:
          "dev/preview ensure returned an invalid activation lifecycle receipt",
        errorClass: "permanent",
        responseStatus: input.status,
        duration_ms,
      };
    }
  }

  if (input.status < 200 || input.status >= 300) {
    const message =
      typeof data.error === "string"
        ? data.error
        : `dev/preview ${input.mode} failed (${input.status})`;
    const explicitActivationFailure =
      activationExpected &&
      (data.activationPhase === "failed" || data.ok === false);
    return {
      success: false,
      data,
      error: message,
			errorClass:
				!explicitActivationFailure && TRANSIENT_DEV_PREVIEW_STATUSES.has(input.status)
					? ("retryable" as const)
					: ("permanent" as const),
      responseStatus: input.status,
      duration_ms,
    };
  }

  return {
    success: true,
    data,
    responseStatus: input.status,
    duration_ms,
  };
}

async function executeDevPreview(
  input: Record<string, unknown>,
  mode: DevPreviewProxyMode,
  dbExecutionId: string | null | undefined,
): Promise<ExecuteResponse> {
  const started = Date.now();
  const binding = bindDevPreviewExecutionId(input, dbExecutionId);
  if (!binding.ok) {
    return {
      success: false,
      data: {},
      error: binding.error,
			errorClass: "permanent" as const,
      responseStatus: 0,
      duration_ms: Date.now() - started,
    } as ExecuteResponse;
  }
  if (
    expectsDurableDevPreviewActivation(input, mode) &&
    requestedDevPreviewServices(input) === null
  ) {
    return {
      success: false,
      data: {},
      error:
        "dev/preview: services must be a non-empty list of unique service ids",
      errorClass: "permanent",
      responseStatus: 0,
      duration_ms: Date.now() - started,
    } as ExecuteResponse;
  }
  if (!PREVIEW_ACTION_INTERNAL_TOKEN) {
    return {
      success: false,
      data: {},
      error:
        "dev/preview: PREVIEW_ACTION_INTERNAL_TOKEN is not configured; refusing privileged proxy",
      errorClass: "permanent" as const,
      responseStatus: 0,
      duration_ms: Date.now() - started,
    } as ExecuteResponse;
  }
  const executionId = binding.executionId;
  const signal = AbortSignal.timeout(DEV_PREVIEW_PROXY_TIMEOUT_MS);
  const url = `${WORKFLOW_BUILDER_URL}/api/internal/workflows/executions/${encodeURIComponent(
    executionId,
  )}/dev-preview`;
  try {
    let res: Response;
    if (mode === "teardown") {
      const sandboxName =
        typeof input.sandboxName === "string" ? input.sandboxName.trim() : "";
      const qs = sandboxName
        ? `?sandboxName=${encodeURIComponent(sandboxName)}`
        : "";
      res = await fetch(`${url}${qs}`, {
        method: "DELETE",
			signal,
        headers: {
          "X-Preview-Action-Token": PREVIEW_ACTION_INTERNAL_TOKEN,
        },
      });
    } else if (mode === "snapshot") {
      // Per-iteration durable code capture: pull the dev pod's /__export and store
      // it as a promotable `source-bundle` version (tar-overlay tier).
      const snap: Record<string, unknown> = {};
      if (typeof input.nodeId === "string") snap.nodeId = input.nodeId;
      if (input.iteration !== undefined && input.iteration !== null)
        snap.iteration = input.iteration;
      if (Array.isArray(input.services)) snap.services = input.services;
      res = await fetch(`${url}/snapshot`, {
        method: "POST",
				signal,
        headers: {
          "Content-Type": "application/json",
          "X-Preview-Action-Token": PREVIEW_ACTION_INTERNAL_TOKEN,
        },
        body: JSON.stringify(snap),
      });
    } else if (mode === "promote") {
      // Promote-from-best: open a PR from a durable per-iteration source bundle
      // (or a freshly captured live export). Forwards the node's with-params.
      const promo: Record<string, unknown> = {};
      for (const key of [
        "iteration",
        "bestIteration",
        "draft",
        "title",
        "bodyMarkdown",
        "repoUrl",
        "baseBranch",
        "branchPrefix",
        "services",
      ]) {
        if (input[key] !== undefined && input[key] !== null)
          promo[key] = input[key];
      }
      res = await fetch(`${url}/promote`, {
        method: "POST",
				signal,
        headers: {
          "Content-Type": "application/json",
          "X-Preview-Action-Token": PREVIEW_ACTION_INTERNAL_TOKEN,
        },
        body: JSON.stringify(promo),
      });
    } else if (mode === "acceptance") {
      res = await fetch(`${url}/acceptance`, {
        method: "POST",
				signal,
        headers: {
          "Content-Type": "application/json",
          "X-Preview-Action-Token": PREVIEW_ACTION_INTERNAL_TOKEN,
        },
        body: JSON.stringify(buildPreviewAcceptancePayload(input)),
      });
    } else if (mode === "build") {
      res = await fetch(`${url}/build`, {
        method: "POST",
				signal,
        headers: {
          "Content-Type": "application/json",
          "X-Preview-Action-Token": PREVIEW_ACTION_INTERNAL_TOKEN,
        },
        body: JSON.stringify(buildDevPreviewBuildPayload(input)),
      });
    } else if (mode === "freeze") {
      // Retained-preview live-sync freeze: make this run's dev-preview sources
      // immutable WITHOUT tearing anything down. Idempotent per service; the
      // BFF route reports per-service {service, frozen|failed} outcomes.
      const freeze: Record<string, unknown> = {};
      if (Array.isArray(input.services)) freeze.services = input.services;
      res = await fetch(`${url}/freeze`, {
        method: "POST",
				signal,
        headers: {
          "Content-Type": "application/json",
          "X-Preview-Action-Token": PREVIEW_ACTION_INTERNAL_TOKEN,
        },
        body: JSON.stringify(freeze),
      });
    } else {
      const payload: Record<string, unknown> = {};
      for (const key of [
        "service",
        // Multi-service adopt (B1): fan out N services into one execution. The BFF
        // route provisionMany-branches on a non-empty `services` array; `service`
        // stays the single-service entry.
        "services",
        "syncToken",
        "timeoutSeconds",
        "waitReadySeconds",
        "image",
        "executionClass",
        // Preview-native adopt mode (in-preview agentic dev loop, P1).
        "mode",
        // Preview-native: adopt=false → dev pod on its IP, no Service takeover (P2 GAN).
        "adopt",
        // The preview's canonical HTTPS origin is required by adopted BFF auth/CSRF.
        "origin",
      ]) {
        if (input[key] !== undefined && input[key] !== null)
          payload[key] = input[key];
      }
      res = await fetch(url, {
        method: "POST",
				signal,
        headers: {
          "Content-Type": "application/json",
          "X-Preview-Action-Token": PREVIEW_ACTION_INTERNAL_TOKEN,
        },
        body: JSON.stringify(payload),
      });
    }
    const text = await res.text();
    const parsed = parseJsonResponse(text);
    return classifyDevPreviewProxyResponse({
      mode,
      requestInput: input,
      executionId,
      status: res.status,
      parsed,
      durationMs: Date.now() - started,
    });
  } catch (err) {
    return {
      success: false,
      data: {},
      error: err instanceof Error ? err.message : String(err),
			errorClass: "retryable" as const,
      responseStatus: 0,
      duration_ms: Date.now() - started,
    } as ExecuteResponse;
  }
}

/** Caller authority is deliberately narrower than the BFF build command. */
export function buildDevPreviewBuildPayload(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (Array.isArray(input.services)) payload.services = input.services;
  if (typeof input.origin === "string") payload.origin = input.origin;
  if (typeof input.adopt === "boolean") payload.adopt = input.adopt;
  return payload;
}

/** Acceptance callers may identify a PR; physical authority derives every other field. */
export function buildPreviewAcceptancePayload(
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (!isPlainObject(input.pullRequest)) return {};
  const pullRequest = input.pullRequest;
  return {
    pullRequest: {
      ...(typeof pullRequest.repository === "string"
        ? { repository: pullRequest.repository }
        : {}),
      ...(typeof pullRequest.number === "number"
        ? { number: pullRequest.number }
        : {}),
      ...(typeof pullRequest.baseSha === "string"
        ? { baseSha: pullRequest.baseSha }
        : {}),
      ...(typeof pullRequest.headSha === "string"
        ? { headSha: pullRequest.headSha }
        : {}),
    },
  };
}

function firstStringField(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function resolveSandboxName(payload: unknown): string | undefined {
  if (!isPlainObject(payload)) return undefined;
  return (
    firstStringField(payload, [
      "sandboxName",
      "sandbox_name",
      "workspaceSandboxName",
    ]) ??
    (isPlainObject(payload.sandbox)
      ? (firstStringField(payload.sandbox, ["sandboxName", "sandbox_name"]) ??
        (isPlainObject(payload.sandbox.details)
          ? firstStringField(payload.sandbox.details, [
              "sandboxName",
              "sandbox_name",
            ])
          : undefined))
      : undefined) ??
    resolveSandboxName(payload.result)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeKnativeExecuteResponse(
  parsed: Record<string, unknown>,
): ExecuteResponse | null {
  const success = parsed.success;
  if (typeof success !== "boolean") {
    return null;
  }

  const explicitData = Object.hasOwn(parsed, "data") ? parsed.data : undefined;
  const fallbackData =
    explicitData !== undefined
      ? explicitData
      : Object.fromEntries(
          Object.entries(parsed).filter(
            ([key]) =>
              key !== "success" &&
              key !== "error" &&
              key !== "errorClass" &&
              key !== "duration_ms" &&
              key !== "routed_to" &&
              key !== "pause",
          ),
        );
  const durationMs =
    typeof parsed.duration_ms === "number" ? parsed.duration_ms : 0;
  const error =
    typeof parsed.error === "string" && parsed.error.trim().length > 0
      ? parsed.error
      : undefined;
  const pause =
    isPlainObject(parsed.pause) &&
    (parsed.pause.type === "DELAY" || parsed.pause.type === "WEBHOOK")
      ? (parsed.pause as ExecuteResponse["pause"])
      : undefined;
  // Retryable/permanent classification from the piece-runtime — the
  // orchestrator's AP retry policy keys off this.
  const errorClass =
    parsed.errorClass === "retryable" || parsed.errorClass === "permanent"
      ? parsed.errorClass
      : undefined;

  return {
    success,
    data: fallbackData,
    error,
    errorClass,
    duration_ms: durationMs,
    pause,
  };
}

function normalizeSystemHttpRequestInput(input: Record<string, unknown>): {
  input: Record<string, unknown>;
  error?: string;
} {
  // Some callers persist params under `configFields`; merge them so runtime always
  // sees the canonical shape expected by fn-system.
  const merged = {
    ...input,
    ...(isPlainObject(input.configFields) ? input.configFields : {}),
  };

  // Back-compat: older schema used { url, method, headers, body }.
  const endpoint =
    typeof merged.endpoint === "string"
      ? merged.endpoint
      : typeof merged.url === "string"
        ? merged.url
        : merged.endpoint;
  const httpMethod =
    typeof merged.httpMethod === "string"
      ? merged.httpMethod
      : typeof merged.method === "string"
        ? merged.method
        : merged.httpMethod;
  const httpHeaders = merged.httpHeaders ?? merged.headers;
  const httpBody = merged.httpBody ?? merged.body;

  const normalized = {
    ...merged,
    endpoint,
    httpMethod,
    httpHeaders,
    httpBody,
    // Keep legacy keys around as well (harmless, helps old templates).
    url: merged.url ?? endpoint,
    method: merged.method ?? httpMethod,
    headers: merged.headers ?? httpHeaders,
    body: merged.body ?? httpBody,
  };

  if (typeof normalized.endpoint !== "string" || !normalized.endpoint.trim()) {
    return {
      input: normalized,
      error:
        "system/http-request: missing required `endpoint` (or legacy `url`). " +
        "Set `endpoint` to a non-empty URL string.",
    };
  }

  return { input: normalized };
}

/** Keys that are metadata, not tool arguments. */
const MASTRA_META_KEYS = new Set(["toolId", "argsJson", "auth"]);

function parseMastraToolInput(
  input: Record<string, unknown>,
  fallbackToolId: string,
): { toolId: string; args: Record<string, unknown> } {
  const configuredToolId =
    typeof input.toolId === "string" ? input.toolId.trim() : "";
  const toolId = configuredToolId || fallbackToolId;

  if (!toolId) {
    throw new Error(
      "Tool ID is required. Set the Tool field in this action node.",
    );
  }

  // If argsJson is provided, parse it (legacy run-tool format).
  const argsRaw = input.argsJson;
  if (typeof argsRaw === "string" && argsRaw.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(argsRaw.trim());
    } catch (error) {
      throw new Error(
        `Invalid tool args JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Tool args JSON must be an object.");
    }

    return { toolId, args: parsed as Record<string, unknown> };
  }

  // Otherwise collect individual input fields as tool args
  // (used by per-tool actions like mastra/read-file, mastra/write-file, etc.)
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!MASTRA_META_KEYS.has(key) && value !== undefined && value !== null) {
      args[key] = value;
    }
  }
  return { toolId, args };
}

function materializedFileTraceMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { validShape: false };
  }
  const file = value as WorkspaceMaterializeFileInput;
  const metadata: Record<string, unknown> = {
    path: typeof file.path === "string" ? file.path : undefined,
    mode: typeof file.mode === "number" ? file.mode : undefined,
  };
  if (typeof file.content === "string") {
    const contentBytes = Buffer.byteLength(file.content, "utf8");
    metadata.contentBytes = contentBytes;
    if (contentBytes <= MAX_WORKSPACE_MATERIALIZE_FILE_BYTES) {
      metadata.contentSha256 = createHash("sha256")
        .update(file.content, "utf8")
        .digest("hex");
    } else {
      metadata.digestOmitted = "oversized";
    }
    metadata.contentEncoding = "utf8";
  } else if (typeof file.contentB64 === "string") {
    const encodedBytes = Buffer.byteLength(file.contentB64, "utf8");
    metadata.encodedBytes = encodedBytes;
    if (
      encodedBytes <=
      Math.ceil(MAX_WORKSPACE_MATERIALIZE_FILE_BYTES / 3) * 4
    ) {
      metadata.encodedSha256 = createHash("sha256")
        .update(file.contentB64, "utf8")
        .digest("hex");
    } else {
      metadata.digestOmitted = "oversized";
    }
    metadata.contentEncoding = "base64";
  } else {
    metadata.contentEncoding = "missing";
  }
  return metadata;
}

function workspaceMaterializeArgsForSpan(
  toolId: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const sourceFiles =
    toolId === "write_file"
      ? [
          {
            path: args.path,
            content: args.content,
            contentB64: args.contentB64,
            mode: args.mode,
          },
        ]
      : Array.isArray(args.files)
        ? args.files
        : [];
  return {
    toolId,
    workspaceRef: args.workspaceRef,
    timeoutMs: args.timeoutMs,
    fileCount: sourceFiles.length,
    files: sourceFiles.map(materializedFileTraceMetadata),
  };
}

export function workspaceMaterializeInputForSpan(
  functionSlug: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const configuredToolId =
    typeof input.toolId === "string" ? input.toolId.trim() : "";
  const fallbackToolId = functionSlug.split("/")[1] ?? "";
  const toolId = configuredToolId || fallbackToolId;
  const isMaterializeAction =
    functionSlug.startsWith("workspace/") &&
    (toolId === "materialize-files" || toolId === "write_file");
  if (!isMaterializeAction) return input;

  if (typeof input.argsJson === "string") {
    try {
      const parsed = JSON.parse(input.argsJson) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return workspaceMaterializeArgsForSpan(
          toolId,
          parsed as Record<string, unknown>,
        );
      }
    } catch {
      return { toolId, payload: "[unparseable materialize arguments]" };
    }
  }

  return workspaceMaterializeArgsForSpan(toolId, input);
}

function optionalStringInput(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

type WorkspaceCommandPayloadOptions = {
  args: Record<string, unknown>;
  executionId: string;
  dbExecutionId?: string | null;
  workflowId: string;
  nodeId: string;
  nodeName: string;
};

export function buildWorkspaceCommandPayload({
  args,
  executionId,
  dbExecutionId,
  workflowId,
  nodeId,
  nodeName,
}: WorkspaceCommandPayloadOptions): Record<string, unknown> {
  const cwd =
    optionalStringInput(args.cwd) ??
    optionalStringInput(args.workingDir) ??
    optionalStringInput(args.workingDirectory);

  return {
    executionId,
    dbExecutionId: dbExecutionId ?? undefined,
    workspaceRef: args.workspaceRef,
    command: args.command ?? args.prompt ?? "",
    env:
      args.env && typeof args.env === "object" && !Array.isArray(args.env)
        ? args.env
        : undefined,
    cwd,
    timeoutMs: args.timeoutMs,
    workflowId,
    nodeId,
    nodeName,
  };
}

type WorkspaceMaterializeFilesPayloadOptions = {
  args: Record<string, unknown>;
  toolId: string;
  executionId: string;
  dbExecutionId?: string | null;
  workflowId: string;
  nodeId: string;
  nodeName: string;
};

type WorkspaceMaterializeFileInput = {
  path?: unknown;
  content?: unknown;
  contentB64?: unknown;
  mode?: unknown;
};

function encodeWorkspaceMaterializeFile(
  value: WorkspaceMaterializeFileInput,
  index: number,
): {
  file: { path: string; contentB64: string; mode?: number };
  decodedBytes: number;
} {
  const rawPath = typeof value.path === "string" ? value.path : "";
  const path = rawPath.trim();
  const pathSegments = path.split("/").slice(1);
  if (
    path !== rawPath ||
    !path.startsWith("/") ||
    !path.startsWith("/sandbox/") ||
    path.length > 4096 ||
    pathSegments.length === 0 ||
    pathSegments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    ) ||
    /[\0\r\n]/.test(path)
  ) {
    throw new Error(
      `workspace materialized file ${index} must have a normalized absolute path`,
    );
  }

  const hasText = typeof value.content === "string";
  const hasEncoded = typeof value.contentB64 === "string";
  if (hasText === hasEncoded) {
    throw new Error(
      `workspace materialized file ${index} must provide exactly one of content or contentB64`,
    );
  }

  const textContent = hasText ? (value.content as string) : undefined;
  const encodedContent = hasEncoded ? String(value.contentB64) : undefined;
  const maxEncodedBytes =
    Math.ceil(MAX_WORKSPACE_MATERIALIZE_FILE_BYTES / 3) * 4;
  if (
    (textContent !== undefined &&
      Buffer.byteLength(textContent, "utf8") >
        MAX_WORKSPACE_MATERIALIZE_FILE_BYTES) ||
    (encodedContent !== undefined && encodedContent.length > maxEncodedBytes)
  ) {
    throw new Error(
      `workspace materialized file ${index} exceeds the 4 MiB limit`,
    );
  }
  const contentB64 =
    encodedContent ?? Buffer.from(textContent ?? "", "utf8").toString("base64");
  const firstPadding = contentB64.indexOf("=");
  const hasValidBase64Shape =
    contentB64.length % 4 === 0 &&
    !/[^A-Za-z0-9+/=]/.test(contentB64) &&
    (firstPadding === -1 ||
      (firstPadding >= contentB64.length - 2 &&
        !contentB64.slice(firstPadding).replaceAll("=", "")));
  const content = Buffer.from(contentB64, "base64");
  if (
    !hasText &&
    (!hasValidBase64Shape || content.toString("base64") !== contentB64)
  ) {
    throw new Error(
      `workspace materialized file ${index} contentB64 must be canonical base64`,
    );
  }
  if (content.byteLength > MAX_WORKSPACE_MATERIALIZE_FILE_BYTES) {
    throw new Error(
      `workspace materialized file ${index} exceeds the 4 MiB limit`,
    );
  }
  const mode = value.mode;
  if (
    mode !== undefined &&
    (!Number.isInteger(mode) || Number(mode) < 0 || Number(mode) > 0o7777)
  ) {
    throw new Error(
      `workspace materialized file ${index} mode must be an integer between 0 and 4095`,
    );
  }

  return {
    file: {
      path,
      contentB64,
      ...(mode === undefined ? {} : { mode: Number(mode) }),
    },
    decodedBytes: content.byteLength,
  };
}

export function buildWorkspaceMaterializeFilesPayload({
  args,
  toolId,
  executionId,
  dbExecutionId,
  workflowId,
  nodeId,
  nodeName,
}: WorkspaceMaterializeFilesPayloadOptions): Record<string, unknown> {
  const workspaceRef =
    typeof args.workspaceRef === "string" ? args.workspaceRef.trim() : "";
  if (!workspaceRef) {
    throw new Error("workspace/materialize-files requires workspaceRef");
  }
  const sourceFiles =
    toolId === "write_file"
      ? [
          {
            path: args.path,
            content: args.content,
            contentB64: args.contentB64,
            mode: args.mode,
          },
        ]
      : args.files;
  if (!Array.isArray(sourceFiles) || sourceFiles.length === 0) {
    throw new Error("workspace/materialize-files requires at least one file");
  }
  if (sourceFiles.length > 64) {
    throw new Error("workspace/materialize-files accepts at most 64 files");
  }

  let totalDecodedBytes = 0;
  const files = sourceFiles.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`workspace materialized file ${index} must be an object`);
    }
    const encoded = encodeWorkspaceMaterializeFile(
      value as WorkspaceMaterializeFileInput,
      index,
    );
    totalDecodedBytes += encoded.decodedBytes;
    if (totalDecodedBytes > MAX_WORKSPACE_MATERIALIZE_TOTAL_BYTES) {
      throw new Error(
        "workspace/materialize-files exceeds the 8 MiB aggregate limit",
      );
    }
    return encoded.file;
  });
  for (let index = 0; index < files.length; index += 1) {
    for (let otherIndex = 0; otherIndex < index; otherIndex += 1) {
      const path = files[index].path;
      const otherPath = files[otherIndex].path;
      if (
        path === otherPath ||
        path.startsWith(`${otherPath}/`) ||
        otherPath.startsWith(`${path}/`)
      ) {
        throw new Error(
          `workspace materialized file ${index} overlaps another destination`,
        );
      }
    }
  }

  return {
    executionId,
    dbExecutionId: dbExecutionId ?? undefined,
    workspaceRef,
    files,
    timeoutMs: args.timeoutMs,
    workflowId,
    nodeId,
    nodeName,
  };
}

export function workspaceMaterializedFilesFromResponse(
  value: unknown,
): unknown[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const response = value as Record<string, unknown>;
  if (Array.isArray(response.files)) return response.files;
  if (
    response.result &&
    typeof response.result === "object" &&
    !Array.isArray(response.result) &&
    Array.isArray((response.result as Record<string, unknown>).files)
  ) {
    return (response.result as Record<string, unknown>).files as unknown[];
  }
  return undefined;
}

function parseBooleanInput(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

function parseStringArrayInput(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const parsed = value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => Boolean(entry));
    return parsed.length > 0 ? [...new Set(parsed)] : undefined;
  }

  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parseStringArrayInput(parsed);
      }
    } catch {
      return undefined;
    }
  }

  const parsed = trimmed
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => Boolean(entry));
  return parsed.length > 0 ? [...new Set(parsed)] : undefined;
}

function parseJsonObjectInput(
  value: unknown,
): Record<string, unknown> | undefined {
  if (isPlainObject(value)) return value;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonValueInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function parseNumberInput(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseDurableAgentConfig(
  input: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return isPlainObject(input.agentConfig) ? input.agentConfig : undefined;
}

function parseDurableModelInput(
  input: Record<string, unknown>,
): string | undefined {
  if (typeof input.model === "string" && input.model.trim()) {
    return input.model.trim();
  }

  const agentConfig = parseDurableAgentConfig(input);
  if (!agentConfig) return undefined;

  if (
    typeof agentConfig.modelSpec === "string" &&
    agentConfig.modelSpec.trim()
  ) {
    return agentConfig.modelSpec.trim();
  }

  if (!isPlainObject(agentConfig.model)) return undefined;
  const provider =
    typeof agentConfig.model.provider === "string"
      ? agentConfig.model.provider.trim()
      : "";
  const name =
    typeof agentConfig.model.name === "string"
      ? agentConfig.model.name.trim()
      : "";
  return provider && name ? `${provider}/${name}` : undefined;
}

function buildStructuredStopCondition(
  input: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const mode =
    typeof input.loopStopMode === "string" ? input.loopStopMode.trim() : "";
  if (!mode || mode === "none" || mode === "custom_json") {
    return undefined;
  }

  if (mode === "stepCountIs") {
    const maxSteps = parseNumberInput(input.loopStopMaxSteps) ?? 20;
    return {
      type: "stepCountIs",
      maxSteps: Math.max(1, Math.floor(maxSteps)),
    };
  }

  if (mode === "hasToolCall") {
    const toolName =
      typeof input.loopStopToolName === "string"
        ? input.loopStopToolName.trim()
        : "";
    return toolName ? { type: "hasToolCall", toolName } : undefined;
  }

  if (mode === "toolCallNeedsApproval") {
    const toolNames = parseStringArrayInput(input.loopStopApprovalToolNames);
    return toolNames
      ? { type: "toolCallNeedsApproval", toolNames }
      : { type: "toolCallNeedsApproval" };
  }

  if (mode === "toolWithoutExecute") {
    return { type: "toolWithoutExecute" };
  }

  if (mode === "assistantTextIncludes") {
    const text =
      typeof input.loopStopText === "string" ? input.loopStopText.trim() : "";
    if (!text) return undefined;
    const caseSensitive = parseBooleanInput(input.loopStopCaseSensitive);
    return caseSensitive === undefined
      ? { type: "assistantTextIncludes", text }
      : { type: "assistantTextIncludes", text, caseSensitive };
  }

  if (mode === "assistantTextMatchesRegex") {
    const pattern =
      typeof input.loopStopRegexPattern === "string"
        ? input.loopStopRegexPattern.trim()
        : "";
    if (!pattern) return undefined;
    const flags =
      typeof input.loopStopRegexFlags === "string"
        ? input.loopStopRegexFlags.trim()
        : "";
    return flags
      ? { type: "assistantTextMatchesRegex", pattern, flags }
      : { type: "assistantTextMatchesRegex", pattern };
  }

  if (mode === "totalUsageAtLeast") {
    const inputTokens = parseNumberInput(input.loopStopInputTokens);
    const outputTokens = parseNumberInput(input.loopStopOutputTokens);
    const totalTokens = parseNumberInput(input.loopStopTotalTokens);
    if (
      inputTokens === undefined &&
      outputTokens === undefined &&
      totalTokens === undefined
    ) {
      return undefined;
    }
    return {
      type: "totalUsageAtLeast",
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
    };
  }

  if (mode === "costEstimateExceeds") {
    const usd = parseNumberInput(input.loopStopCostUsd);
    if (usd === undefined) return undefined;
    const inputPer1kUsd = parseNumberInput(input.loopStopCostInputPer1kUsd);
    const outputPer1kUsd = parseNumberInput(input.loopStopCostOutputPer1kUsd);
    return {
      type: "costEstimateExceeds",
      usd,
      ...(inputPer1kUsd !== undefined ? { inputPer1kUsd } : {}),
      ...(outputPer1kUsd !== undefined ? { outputPer1kUsd } : {}),
    };
  }

  if (mode === "celExpression") {
    const expression =
      typeof input.loopStopCelExpression === "string"
        ? input.loopStopCelExpression.trim()
        : "";
    return expression ? { type: "celExpression", expression } : undefined;
  }

  return undefined;
}

function buildLoopPolicyInput(
  input: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const basePolicy = parseJsonObjectInput(input.loopPolicy) ?? {};
  const policy: Record<string, unknown> = { ...basePolicy };
  let hasLoopConfig = Object.keys(policy).length > 0;

  const stopWhenFromJson = parseJsonValueInput(input.loopStopWhen);
  const stopConditionFromMode = buildStructuredStopCondition(input);
  if (Array.isArray(stopWhenFromJson) || isPlainObject(stopWhenFromJson)) {
    policy.stopWhen = stopWhenFromJson;
    hasLoopConfig = true;
  } else if (stopConditionFromMode) {
    policy.stopWhen = [stopConditionFromMode];
    hasLoopConfig = true;
  }

  const prepareStep = parseJsonObjectInput(input.loopPrepareStep);
  if (prepareStep) {
    policy.prepareStep = prepareStep;
    hasLoopConfig = true;
  }

  const approvalRequiredTools = parseStringArrayInput(
    input.loopApprovalRequiredTools,
  );
  if (approvalRequiredTools) {
    policy.approvalRequiredTools = approvalRequiredTools;
    hasLoopConfig = true;
  }

  const defaultActiveTools = parseStringArrayInput(
    input.loopDefaultActiveTools,
  );
  if (defaultActiveTools) {
    policy.defaultActiveTools = defaultActiveTools;
    hasLoopConfig = true;
  }

  const defaultToolChoiceRaw =
    typeof input.loopDefaultToolChoice === "string"
      ? input.loopDefaultToolChoice.trim().toLowerCase()
      : "";
  if (
    defaultToolChoiceRaw === "auto" ||
    defaultToolChoiceRaw === "required" ||
    defaultToolChoiceRaw === "none"
  ) {
    policy.defaultToolChoice = defaultToolChoiceRaw;
    hasLoopConfig = true;
  } else if (defaultToolChoiceRaw === "tool") {
    const toolName =
      typeof input.loopDefaultToolName === "string"
        ? input.loopDefaultToolName.trim()
        : "";
    if (toolName) {
      policy.defaultToolChoice = {
        type: "tool",
        toolName,
      };
      hasLoopConfig = true;
    }
  }

  const doneToolEnabled = parseBooleanInput(input.loopDoneToolEnabled);
  const doneToolName =
    typeof input.loopDoneToolName === "string"
      ? input.loopDoneToolName.trim()
      : "";
  const doneToolDescription =
    typeof input.loopDoneToolDescription === "string"
      ? input.loopDoneToolDescription.trim()
      : "";
  const doneToolResponseField =
    typeof input.loopDoneToolResponseField === "string"
      ? input.loopDoneToolResponseField.trim()
      : "";
  const doneToolInputSchema = parseJsonValueInput(
    input.loopDoneToolInputSchema,
  );
  const hasDoneToolOverrides =
    doneToolEnabled !== undefined ||
    Boolean(doneToolName) ||
    Boolean(doneToolDescription) ||
    Boolean(doneToolResponseField) ||
    doneToolInputSchema !== undefined;

  if (hasDoneToolOverrides) {
    const existingDoneTool = isPlainObject(policy.doneTool)
      ? policy.doneTool
      : {};
    const doneTool: Record<string, unknown> = { ...existingDoneTool };
    if (doneToolEnabled !== undefined) {
      doneTool.enabled = doneToolEnabled;
    }
    if (doneToolName) {
      doneTool.name = doneToolName;
    }
    if (doneToolDescription) {
      doneTool.description = doneToolDescription;
    }
    if (doneToolResponseField) {
      doneTool.responseField = doneToolResponseField;
    }
    if (doneToolInputSchema && typeof doneToolInputSchema === "object") {
      doneTool.inputSchema = doneToolInputSchema;
    }
    policy.doneTool = doneTool;
    hasLoopConfig = true;
  }

  return hasLoopConfig ? policy : undefined;
}

export async function executeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", async (request) => {
    if (request.raw.url?.startsWith("/execute")) {
      rememberRequestServerSpan(request);
    }
  });

  // Stamp `output.value` (redacted) onto the active span for every response
  // this plugin's routes emit, so the Service Graph drawer shows the payload
  // function-router actually returned — not just HTTP status + duration.
  app.addHook("onSend", async (request, _reply, payload) => {
    const targets = spanTargetsForRequest(request);
    if (targets.length === 0) {
      setSpanOutput(payload);
    } else {
      for (const span of targets) {
        setSpanOutputOnSpan(span, payload);
      }
    }
    return payload;
  });

  const retiredAgentPrefixes = new Set([
    "durable",
    "dapr-agent",
    "dapr-agent-py",
    "dapr-swe",
    "claude",
    "mastra",
    "ms-agent",
    "openshell-langgraph",
    "openshell-deepagent",
    "openshell-durable",
    "vanilla-durable",
  ]);
  /**
   * POST /execute - Route function execution to appropriate service
   */
  app.post<{ Body: ExecuteRequest }>("/execute", async (request, reply) => {
    // Validate request body
    const parseResult = ExecuteRequestSchema.safeParse(request.body);

    if (!parseResult.success) {
      return reply.status(400).send({
        success: false,
        error: "Validation failed",
        details: parseResult.error.issues,
        duration_ms: 0,
      } as ExecuteResponse);
    }

    const body = parseResult.data as ExecuteRequest;
    const bodyOtel =
      body._otel && typeof body._otel === "object" ? body._otel : undefined;
    const workflowActivityContext = workflowActivityContextFromHeaders(
      request.headers,
      bodyOtel,
    );
    // Stamp the routed action input as `input.value` (redacted) for the drawer.
    const requestPayload = executeRequestForSpan(body);
    const routeAttributes = {
      "workflow.id": body.workflow_id,
      "workflow.node.id": body.node_id,
      "workflow.node.name": body.node_name,
      "workflow.node.sequence":
        workflowActivityContext.nodeSequence ?? undefined,
      "workflow.node.action_type":
        workflowActivityContext.actionType ??
        body.function_slug ??
        body.function_id,
      "workflow.activity.correlation_id":
        workflowActivityContext.activityCorrelationId ?? undefined,
      "workflow.execution.id": body.db_execution_id ?? body.execution_id,
    };
    const spanTargets = spanTargetsForRequest(request);
    if (spanTargets.length === 0) {
      setSpanInput(requestPayload);
      setActiveHttpRouteAttributes("/execute", routeAttributes);
    } else {
      for (const span of spanTargets) {
        setSpanInputOnSpan(span, requestPayload);
        setHttpRouteAttributesOnSpan(span, "/execute", routeAttributes);
      }
    }
    const resolvedSessionId =
      buildWorkflowSessionId(body.db_execution_id || body.execution_id) ||
      sessionIdFromHeaders(request.headers, bodyOtel);
    if (resolvedSessionId) {
      bindWorkflowSessionContext({
        sessionId: resolvedSessionId,
        workflowExecutionId:
          workflowActivityContext.workflowExecutionId ??
          body.db_execution_id ??
          body.execution_id,
        workflowId: body.workflow_id,
        traceGroupId: body.db_execution_id || body.execution_id,
        activityCorrelationId: workflowActivityContext.activityCorrelationId,
        nodeId: workflowActivityContext.nodeId ?? body.node_id,
        nodeName: workflowActivityContext.nodeName ?? body.node_name,
        nodeSequence: workflowActivityContext.nodeSequence,
        actionType:
          workflowActivityContext.actionType ??
          body.function_slug ??
          body.function_id,
      });
    }
    const functionSlug = body.function_slug || body.function_id;

    if (!functionSlug) {
      return reply.status(400).send({
        success: false,
        error: "Either function_id or function_slug is required",
        duration_ms: 0,
      } as ExecuteResponse);
    }

		if (
			!previewActionRequestAuthorized(functionSlug, request.headers["x-preview-action-token"])
		) {
			return reply.status(401).send({
				success: false,
				data: {},
				error: "unauthorized preview development action caller",
				errorClass: "permanent",
				duration_ms: 0,
			} as ExecuteResponse);
		}

    const pluginId = functionSlug.split("/")[0];
    if (functionSlug !== "durable/run" && retiredAgentPrefixes.has(pluginId)) {
      return reply.status(410).send({
        success: false,
        error: `The ${pluginId} runtime has been retired. Use durable/run for embedded agent execution instead.`,
        duration_ms: 0,
      } as ExecuteResponse);
    }

    // goal/plan is a thin proxy to the BFF's planGoal capability (not a Knative
    // service / registry entry). Handle it before registry lookup.
    if (functionSlug === "goal/plan") {
      const planResponse = await executeGoalPlan(
        body.input as Record<string, unknown>,
      );
      return reply.status(planResponse.success ? 200 : 502).send(planResponse);
    }

		if ((PREVIEW_DEVELOPMENT_ACTION_SLUGS as readonly string[]).includes(functionSlug)) {
			const previewDevelopmentResponse = await executePreviewDevelopmentAction({
				actionSlug: functionSlug as PreviewDevelopmentActionSlug,
				actionInput: body.input as Record<string, unknown>,
				dbExecutionId: body.db_execution_id,
				idempotencyKey: body.idempotency_key,
			});
			// Transport authentication succeeded. Preserve action-level permanent vs
			// retryable classification in a durable HTTP-200 envelope.
			return reply.status(200).send(previewDevelopmentResponse);
		}

    if (functionSlug === "browser/start-preview") {
      const previewResponse = await executeBrowserStartPreviewAction({
        actionInput: body.input as Record<string, unknown>,
        dbExecutionId: body.db_execution_id,
        nodeId: body.node_id,
      });
      // Keep application-level retryability in the durable action envelope.
      return reply.status(200).send(previewResponse);
    }

    // dev/preview (+ dev/preview-teardown + dev/preview-snapshot) proxy to the BFF
    // per-run dev-server Sandbox endpoint (not a Knative service / registry entry).
    if (
      functionSlug === "dev/preview" ||
      functionSlug === "dev/preview-teardown" ||
      functionSlug === "dev/preview-snapshot" ||
      functionSlug === "dev/preview-promote" ||
      functionSlug === "dev/preview-acceptance" ||
      functionSlug === "dev/preview-build" ||
      functionSlug === "dev/preview-freeze"
    ) {
      const devResponse = await executeDevPreview(
        body.input as Record<string, unknown>,
        functionSlug === "dev/preview-teardown"
          ? "teardown"
          : functionSlug === "dev/preview-snapshot"
            ? "snapshot"
            : functionSlug === "dev/preview-promote"
              ? "promote"
              : functionSlug === "dev/preview-acceptance"
                ? "acceptance"
                : functionSlug === "dev/preview-build"
                  ? "build"
                  : functionSlug === "dev/preview-freeze"
                    ? "freeze"
                    : "ensure",
        body.db_execution_id,
      );
      // A staged dev/preview activation carries retryability and the target HTTP
      // status in its action envelope. Keep the router request successful so the
      // durable workflow can poll/retry it across pod replacement.
			return reply.status(200).send(devResponse);
    }

    // session/spawn — workflow → interactive dev-session handoff (proxy to BFF).
    if (functionSlug === "session/spawn") {
      const sessionResponse = await executeSessionSpawn(
        body.input as Record<string, unknown>,
        body.db_execution_id ?? body.execution_id ?? undefined,
      );
      return reply
        .status(sessionResponse.success ? 200 : 502)
        .send(sessionResponse);
    }

    console.log(
      `[Execute Route] Received request for function: ${functionSlug}`,
    );
    console.log(
      `[Execute Route] Workflow: ${body.workflow_id}, Node: ${body.node_name}`,
    );

    const startTime = Date.now();
    const forwardedTraceHeaders = Object.fromEntries(
      (["traceparent", "tracestate", "baggage"] as const)
        .map((headerName) => {
          const value = request.headers[headerName] ?? bodyOtel?.[headerName];
          return [
            headerName,
            typeof value === "string" ? value.trim() : "",
          ] as const;
        })
        .filter((entry) => entry[1].length > 0),
    );
    if (resolvedSessionId) {
      forwardedTraceHeaders["x-workflow-session-id"] = resolvedSessionId;
    }

    // Initialize timing breakdown
    const timing: TimingBreakdown = {};

    // Log execution start (only if we have a valid database execution ID)
    let logId: string | undefined;
    if (body.db_execution_id) {
      try {
        logId = await logExecutionStart({
          executionId: body.db_execution_id,
          nodeId: body.node_id,
          nodeName: body.node_name,
          nodeType: "action",
          actionType: functionSlug,
          input: requestPayload.input,
        });
      } catch (logError) {
        console.error(
          "[Execute Route] Failed to log execution start:",
          logError,
        );
      }
    }

    // Step 1: Look up the target service. Type "activepieces" entries carry
    // no fixed appId — the target is the per-piece piece-runtime Knative
    // Service (reconciler naming contract: ap-<sanitized-piece>-service).
    const registryTarget = await lookupFunction(functionSlug);
    const isApRoute = registryTarget.type === "activepieces";
    const target: { appId: string; type: "knative" | "openfunction" } =
      registryTarget.type === "activepieces"
        ? { appId: apPieceServiceName(pluginId), type: "knative" }
        : registryTarget;
    console.log(
      `[Execute Route] Routing ${functionSlug} to ${target.appId} (${registryTarget.type})`,
    );
    timing.routedTo = target.appId;

    // Step 2: Create Dapr client for service invocation
    const client = new DaprClient({
      daprHost: DAPR_HOST,
      daprPort: DAPR_HTTP_PORT,
    });

    try {
      let response: ExecuteResponse | null = null;

      if (target.type === "knative" || target.type === "openfunction") {
        // Route to Knative service via direct HTTP
        // Extract the step name from the slug (e.g., "openai/generate-text" -> "generate-text")
        const stepName = functionSlug.split("/")[1] || functionSlug;

        // Resolve the function URL (Knative Service DNS in Knative-only mode)
        const routingStartTime = Date.now();
        const functionUrl = shouldUseDaprInvocation(target.appId)
          ? daprInvocationBaseUrl(target.appId)
          : await resolveOpenFunctionUrl(target.appId);
        timing.routingMs = Date.now() - routingStartTime;

        const isBuiltinRuntime =
          target.appId === "durable-agent" ||
          target.appId === "workspace-runtime" ||
          target.appId === "openshell-agent-runtime";

        if (isBuiltinRuntime) {
          console.log(
            `[Execute Route] Invoking ${target.appId} step: ${stepName} at ${functionUrl} (routing: ${timing.routingMs}ms)`,
          );
          let requestTimeoutMs = HTTP_TIMEOUT_MS;
          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          let executionStartTime = Date.now();
          let targetUrl = functionUrl;
          let requestBody = "";
          let traceRequestPayload: unknown;

          try {
            const { toolId, args } = parseMastraToolInput(
              body.input as Record<string, unknown>,
              stepName,
            );

            // Credential resolution for clone operations
            if (
              toolId === "clone" &&
              !args.githubToken &&
              !args.repositoryToken
            ) {
              const authValue = (body.input as Record<string, unknown>)?.auth;
              const parsedConnectionId =
                parseConnectionExternalIdFromAuthTemplate(authValue) ||
                body.connection_external_id;

              if (parsedConnectionId) {
                try {
                  const credResult = await fetchCredentialsWithAudit(
                    "github",
                    body.integrations,
                    body.db_execution_id
                      ? {
                          executionId: body.db_execution_id,
                          nodeId: body.node_id,
                        }
                      : undefined,
                    parsedConnectionId,
                  );
                  if (credResult.credentials.GITHUB_TOKEN) {
                    args.githubToken = credResult.credentials.GITHUB_TOKEN;
                  }
                } catch (err) {
                  console.warn(
                    "[Execute Route] GitHub credential resolution failed for clone action:",
                    err,
                  );
                }
              }
            }

            // Credential resolution for workspace/command operations.
            // Mirrors the clone path: if a github connectionExternalId is present
            // (top-level body.connection_external_id OR `auth: '{{connections[...]}}'`
            // template inside the input), fetch the connection's decrypted token
            // and inject it as GITHUB_TOKEN into args.env so shell scripts can use
            // `https://x-access-token:${GITHUB_TOKEN}@github.com/...` URLs without
            // the workflow author plumbing the token by hand.
            if (toolId === "command" && pluginId === "workspace") {
              const existingEnv =
                args.env &&
                typeof args.env === "object" &&
                !Array.isArray(args.env)
                  ? (args.env as Record<string, string>)
                  : undefined;
              if (!existingEnv?.GITHUB_TOKEN) {
                const authValue = (body.input as Record<string, unknown>)?.auth;
                const parsedConnectionId =
                  parseConnectionExternalIdFromAuthTemplate(authValue) ||
                  body.connection_external_id;
                if (parsedConnectionId) {
                  try {
                    const credResult = await fetchCredentialsWithAudit(
                      "github",
                      body.integrations,
                      body.db_execution_id
                        ? {
                            executionId: body.db_execution_id,
                            nodeId: body.node_id,
                          }
                        : undefined,
                      parsedConnectionId,
                    );
                    if (credResult.credentials.GITHUB_TOKEN) {
                      args.env = {
                        ...(existingEnv ?? {}),
                        GITHUB_TOKEN: credResult.credentials.GITHUB_TOKEN,
                      };
                    }
                  } catch (err) {
                    console.warn(
                      "[Execute Route] GitHub credential resolution failed for workspace/command:",
                      err,
                    );
                  }
                }
              }
            }

            const isAgentRun = toolId === "run";
            const isPlan = toolId === "plan";
            const isClaudePlan = toolId === "claude-plan";
            const isMaterializePlan = toolId === "materialize-plan";
            const isExecutePlan = toolId === "execute";
            const isWorkspaceProfile =
              pluginId === "workspace" && toolId === "profile";
            const isWorkspaceClone =
              pluginId === "workspace" && toolId === "clone";
            const isWorkspacePublishGitea =
              pluginId === "workspace" && toolId === "publish-gitea";
            const isWorkspaceCommand =
              pluginId === "workspace" && toolId === "command";
            const isWorkspaceMaterializeFiles =
              pluginId === "workspace" &&
              (toolId === "materialize-files" || toolId === "write_file");
            const isWorkspaceFile =
              pluginId === "workspace" && toolId === "file";
            const isWorkspaceCleanup =
              pluginId === "workspace" && toolId === "cleanup";
            const isWorkspaceCreatePullRequest =
              pluginId === "workspace" && toolId === "create-pull-request";
            const isBrowserProfile =
              pluginId === "browser" && toolId === "profile";
            const isBrowserClone = pluginId === "browser" && toolId === "clone";
            const isBrowserCommand =
              pluginId === "browser" && toolId === "command";
            const isBrowserCleanup =
              pluginId === "browser" && toolId === "cleanup";
            const isBrowserMaterializeChangeArtifact =
              pluginId === "browser" &&
              toolId === "materialize-change-artifact";
            const isBrowserCaptureFlow =
              pluginId === "browser" && toolId === "capture-flow";
            const isBrowserValidate =
              pluginId === "browser" && toolId === "validate";
            const isBrowserStopPreview =
              pluginId === "browser" && toolId === "stop-preview";
            const isWorkspaceUtility =
              isWorkspaceProfile ||
              isWorkspaceClone ||
              isWorkspacePublishGitea ||
              isWorkspaceCommand ||
              isWorkspaceMaterializeFiles ||
              isWorkspaceFile ||
              isWorkspaceCleanup ||
              isWorkspaceCreatePullRequest;
            const isBrowserUtility =
              isBrowserProfile ||
              isBrowserClone ||
              isBrowserCommand ||
              isBrowserCleanup ||
              isBrowserMaterializeChangeArtifact ||
              isBrowserCaptureFlow ||
              isBrowserValidate ||
              isBrowserStopPreview;
            requestTimeoutMs = isBuiltinRuntime
              ? isWorkspaceUtility || isBrowserUtility
                ? resolveWorkspaceUtilityTimeoutMs({
                    toolId,
                    timeoutMs: args.timeoutMs,
                    commandTimeoutMs: args.commandTimeoutMs,
                  }) +
                  (isBrowserCaptureFlow || isBrowserValidate
                    ? BROWSER_CAPTURE_OVERHEAD_MS
                    : 0)
                : resolveAgentHttpTimeoutMs(args.timeoutMinutes)
              : HTTP_TIMEOUT_MS;
            const controller = new AbortController();
            timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);
            executionStartTime = Date.now();
            const workspaceExecutionId =
              typeof body.db_execution_id === "string" &&
              body.db_execution_id.trim()
                ? body.db_execution_id.trim()
                : body.execution_id;
            const browserDbExecutionId =
              typeof body.db_execution_id === "string" &&
              body.db_execution_id.trim().length > 0
                ? body.db_execution_id.trim()
                : typeof args.dbExecutionId === "string" &&
                    args.dbExecutionId.trim().length > 0
                  ? args.dbExecutionId.trim()
                  : undefined;
            const browserWorkflowId =
              typeof body.workflow_id === "string" &&
              body.workflow_id.trim().length > 0
                ? body.workflow_id.trim()
                : typeof args.workflowId === "string" &&
                    args.workflowId.trim().length > 0
                  ? args.workflowId.trim()
                  : undefined;
            const browserNodeId =
              typeof body.node_id === "string" && body.node_id.trim().length > 0
                ? body.node_id.trim()
                : typeof args.nodeId === "string" &&
                    args.nodeId.trim().length > 0
                  ? args.nodeId.trim()
                  : undefined;
            const browserNodeName =
              typeof body.node_name === "string" &&
              body.node_name.trim().length > 0
                ? body.node_name.trim()
                : typeof args.nodeName === "string" &&
                    args.nodeName.trim().length > 0
                  ? args.nodeName.trim()
                  : browserNodeId;
            targetUrl = functionUrl;
            requestBody = "";
            const loopPolicy = buildLoopPolicyInput(args);
            const model = parseDurableModelInput(args);
            const agentConfig = parseDurableAgentConfig(args);
            const requiredCapabilities =
              parseStringArrayInput(args.requiredCapabilities) ??
              parseStringArrayInput(agentConfig?.requiredCapabilities);
            const preferredExecutionProfile =
              typeof args.preferredExecutionProfile === "string" &&
              args.preferredExecutionProfile.trim()
                ? args.preferredExecutionProfile.trim()
                : typeof agentConfig?.preferredExecutionProfile === "string" &&
                    agentConfig.preferredExecutionProfile.trim()
                  ? agentConfig.preferredExecutionProfile.trim()
                  : undefined;
            const preferredSandboxProfile =
              typeof args.preferredSandboxProfile === "string" &&
              args.preferredSandboxProfile.trim()
                ? args.preferredSandboxProfile.trim()
                : typeof agentConfig?.preferredSandboxProfile === "string" &&
                    agentConfig.preferredSandboxProfile.trim()
                  ? agentConfig.preferredSandboxProfile.trim()
                  : undefined;
            const runMode =
              typeof args.mode === "string"
                ? args.mode.trim().toLowerCase()
                : "execute_direct";
            const hasWorkspaceRef =
              typeof args.workspaceRef === "string" &&
              args.workspaceRef.trim().length > 0;
            const shouldWaitForAgentCompletion =
              isAgentRun && runMode === "execute_direct";
            const workspaceRuntimeUrl =
              isBrowserProfile ||
              isBrowserClone ||
              isBrowserCommand ||
              isBrowserCleanup ||
              isBrowserMaterializeChangeArtifact ||
              isBrowserCaptureFlow ||
              isBrowserStopPreview
                ? await resolveOpenFunctionUrl("workspace-runtime")
                : undefined;

            if (isAgentRun) {
              if (runMode === "plan_mode") {
                targetUrl = `${functionUrl}/api/plan`;
                requestBody = JSON.stringify({
                  prompt: args.prompt ?? "",
                  mode: "plan_mode",
                  cwd: args.cwd ?? "",
                  executionMode:
                    typeof args.workspaceRef === "string" &&
                    args.workspaceRef.trim().length > 0
                      ? "sandboxed"
                      : undefined,
                  model,
                  maxTurns: args.maxTurns,
                  timeoutMinutes: args.timeoutMinutes,
                  instructions: args.instructions,
                  tools: args.tools,
                  agentGraph: args.agentGraph,
                  agentConfig,
                  loopPolicy,
                  workspaceRef:
                    typeof args.workspaceRef === "string"
                      ? args.workspaceRef
                      : undefined,
                  parentExecutionId: body.execution_id,
                  executionId: workspaceExecutionId,
                  dbExecutionId: body.db_execution_id ?? undefined,
                  workflowId: body.workflow_id,
                  nodeId: body.node_id,
                  nodeName: body.node_name,
                  waitForCompletion: true,
                });
              } else {
                targetUrl = `${functionUrl}/api/run`;
                requestBody = JSON.stringify({
                  prompt: args.prompt ?? "",
                  mode: runMode || "execute_direct",
                  cwd: args.cwd ?? "",
                  executionMode:
                    typeof args.workspaceRef === "string" &&
                    args.workspaceRef.trim().length > 0
                      ? "sandboxed"
                      : undefined,
                  model,
                  maxTurns: args.maxTurns,
                  timeoutMinutes: args.timeoutMinutes,
                  instructions: args.instructions,
                  tools: args.tools,
                  agentGraph: args.agentGraph,
                  agentConfig,
                  loopPolicy,
                  stopCondition: args.stopCondition,
                  requireFileChanges: args.requireFileChanges,
                  waitForCompletion: shouldWaitForAgentCompletion,
                  cleanupWorkspace: args.cleanupWorkspace,
                  workspaceRef:
                    typeof args.workspaceRef === "string"
                      ? args.workspaceRef
                      : undefined,
                  parentExecutionId: body.execution_id,
                  executionId: workspaceExecutionId,
                  dbExecutionId: body.db_execution_id ?? undefined,
                  workflowId: body.workflow_id,
                  nodeId: body.node_id,
                  nodeName: body.node_name,
                });
              }
            } else if (isPlan || isClaudePlan) {
              targetUrl = `${functionUrl}/api/plan`;
              requestBody = JSON.stringify({
                prompt: args.prompt ?? "",
                cwd: args.cwd ?? "",
                executionMode:
                  typeof args.workspaceRef === "string" &&
                  args.workspaceRef.trim().length > 0
                    ? "sandboxed"
                    : undefined,
                model,
                maxTurns: args.maxTurns,
                timeoutMinutes: args.timeoutMinutes,
                planningBackend: isClaudePlan ? "claude_code_v1" : undefined,
                instructions: args.instructions,
                tools: args.tools,
                agentConfig,
                loopPolicy,
                workspaceRef:
                  typeof args.workspaceRef === "string"
                    ? args.workspaceRef
                    : undefined,
                parentExecutionId: body.execution_id,
                executionId: workspaceExecutionId,
                dbExecutionId: body.db_execution_id ?? undefined,
                workflowId: body.workflow_id,
                nodeId: body.node_id,
                nodeName: body.node_name,
              });
            } else if (isMaterializePlan) {
              targetUrl = `${functionUrl}/api/plan/materialize`;
              requestBody = JSON.stringify({
                artifactRef:
                  typeof args.artifactRef === "string" ? args.artifactRef : "",
                workspaceRef:
                  typeof args.workspaceRef === "string"
                    ? args.workspaceRef
                    : undefined,
                outputDir:
                  typeof args.outputDir === "string"
                    ? args.outputDir
                    : undefined,
                executionId: workspaceExecutionId,
                dbExecutionId: body.db_execution_id ?? undefined,
                workflowId: body.workflow_id,
                nodeId: body.node_id,
                nodeName: body.node_name,
              });
            } else if (isExecutePlan) {
              let plan = args.planJson;
              if (typeof plan === "string") {
                try {
                  plan = JSON.parse(plan);
                } catch {
                  /* pass as-is */
                }
              }
              targetUrl = `${functionUrl}/api/execute-plan`;
              requestBody = JSON.stringify({
                prompt: args.prompt ?? "",
                plan,
                cwd: args.cwd ?? "",
                executionMode:
                  typeof args.workspaceRef === "string" &&
                  args.workspaceRef.trim().length > 0
                    ? "sandboxed"
                    : undefined,
                maxTurns: args.maxTurns,
                loopPolicy,
                cleanupWorkspace: args.cleanupWorkspace,
                parentExecutionId: body.execution_id,
                executionId: workspaceExecutionId,
                dbExecutionId: body.db_execution_id ?? undefined,
                workflowId: body.workflow_id,
                nodeId: body.node_id,
                nodeName: body.node_name,
              });
            } else if (isWorkspaceProfile) {
              targetUrl = `${functionUrl}/api/workspaces/profile`;
              requestBody = JSON.stringify({
                executionId: workspaceExecutionId,
                dbExecutionId: body.db_execution_id ?? undefined,
                name: args.name,
                rootPath: args.rootPath,
                enabledTools: args.enabledTools,
                requireReadBeforeWrite: args.requireReadBeforeWrite,
                commandTimeoutMs: args.commandTimeoutMs,
                sandboxTemplate: args.sandboxTemplate,
                sandboxImage: args.sandboxImage,
                workspaceRef: args.workspaceRef,
                reuseExecutionWorkspace: args.reuseExecutionWorkspace,
                keepAfterRun: args.keepAfterRun,
                ttlSeconds: args.ttlSeconds,
                managedBy: args.managedBy,
                capacityOwnerLabels: args.capacityOwnerLabels,
                sandboxPolicy: args.sandboxPolicy,
                // Forward the CMA-shape package manifest so openshell-agent-
                // runtime can install declared deps before the first agent
                // turn. Entries are {manager, spec}; empty/missing is a no-op.
                environmentPackages: args.environmentPackages,
                // Surface any extra env config (networking toggles, metadata)
                // verbatim so future openshell-agent-runtime features can
                // opt in without another function-router rebuild.
                environmentConfig: args.environmentConfig,
                workflowId: body.workflow_id,
                nodeId: body.node_id,
                nodeName: body.node_name,
              });
            } else if (isWorkspaceClone || isBrowserClone) {
              const repositoryUrl =
                typeof args.repositoryUrl === "string"
                  ? args.repositoryUrl.trim()
                  : "";
              const repositoryOwner =
                typeof args.repositoryOwner === "string"
                  ? args.repositoryOwner.trim()
                  : "";
              const repositoryRepo =
                typeof args.repositoryRepo === "string"
                  ? args.repositoryRepo.trim()
                  : "";
              const repositoryBranch =
                typeof args.repositoryBranch === "string"
                  ? args.repositoryBranch.trim()
                  : "";
              const repositoryUsername =
                typeof args.repositoryUsername === "string"
                  ? args.repositoryUsername.trim()
                  : "";
              const repositoryToken =
                typeof args.repositoryToken === "string"
                  ? args.repositoryToken.trim()
                  : "";
              const githubToken =
                typeof args.githubToken === "string"
                  ? args.githubToken.trim()
                  : "";
              const skipGiteaMirror =
                args.skipGiteaMirror === true ||
                args.directClone === true ||
                args.mirrorToGitea === false;

              if (!repositoryBranch) {
                throw new Error(
                  "workspace/clone requires repositoryBranch and repository source",
                );
              }

              const resolved = skipGiteaMirror
                ? {
                    repositoryUrl,
                    repositoryOwner,
                    repositoryRepo,
                    repositoryUsername,
                    repositoryToken,
                    ensuredInGitea: false,
                  }
                : await resolveCloneRepository({
                    repositoryUrl,
                    repositoryOwner,
                    repositoryRepo,
                    repositoryBranch,
                    repositoryUsername,
                    repositoryToken,
                    githubToken,
                  });
              if (resolved.ensuredInGitea) {
                console.log(
                  `[Execute Route] workspace/clone ensured Gitea repo ${resolved.repositoryOwner}/${resolved.repositoryRepo}`,
                );
              } else if (skipGiteaMirror) {
                console.log(
                  "[Execute Route] workspace/clone using direct repository clone",
                );
              }

              targetUrl = `${isBrowserClone ? (workspaceRuntimeUrl ?? functionUrl) : functionUrl}/api/workspaces/clone`;
              requestBody = JSON.stringify({
                executionId: workspaceExecutionId,
                dbExecutionId: body.db_execution_id ?? undefined,
                workspaceRef: args.workspaceRef,
                repositoryUrl: resolved.repositoryUrl,
                repositoryOwner: resolved.repositoryOwner,
                repositoryRepo: resolved.repositoryRepo,
                repositoryBranch,
                repositoryUsername:
                  resolved.repositoryUsername ||
                  (skipGiteaMirror && githubToken ? "x-access-token" : ""),
                targetDir: args.targetDir,
                repositoryToken:
                  resolved.repositoryToken ||
                  (skipGiteaMirror ? githubToken : ""),
                githubToken,
                timeoutMs: args.timeoutMs,
                workflowId: body.workflow_id,
                nodeId: body.node_id,
                nodeName: body.node_name,
              });
            } else if (isWorkspacePublishGitea) {
              const repositoryOwner =
                typeof args.repositoryOwner === "string"
                  ? args.repositoryOwner.trim()
                  : "";
              const repositoryRepo =
                typeof args.repositoryRepo === "string"
                  ? args.repositoryRepo.trim()
                  : "";
              const repositoryBranch =
                typeof args.repositoryBranch === "string" &&
                args.repositoryBranch.trim()
                  ? args.repositoryBranch.trim()
                  : "main";
              const repositoryUsername =
                typeof args.repositoryUsername === "string"
                  ? args.repositoryUsername.trim()
                  : "";
              const repositoryToken =
                typeof args.repositoryToken === "string"
                  ? args.repositoryToken.trim()
                  : "";

              const resolved = await ensureGiteaPublishRepository({
                repositoryOwner: repositoryOwner || undefined,
                repositoryRepo,
                repositoryBranch,
                repositoryUsername,
                repositoryToken,
                description:
                  typeof args.description === "string"
                    ? args.description
                    : undefined,
                private: parseBooleanInput(args.private) ?? false,
              });
              console.log(
                `[Execute Route] workspace/publish-gitea resolved ${resolved.repositoryOwner}/${resolved.repositoryRepo} created=${resolved.created}`,
              );

              targetUrl = `${functionUrl}/api/workspaces/publish-gitea`;
              requestBody = JSON.stringify({
                executionId: workspaceExecutionId,
                dbExecutionId: body.db_execution_id ?? undefined,
                workspaceRef: args.workspaceRef,
                repositoryUrl: resolved.repositoryUrl,
                repositoryOwner: resolved.repositoryOwner,
                repositoryRepo: resolved.repositoryRepo,
                repositoryBranch,
                repositoryUsername: resolved.repositoryUsername,
                repositoryToken: resolved.repositoryToken,
                commitMessage: args.commitMessage,
                gitUserName: args.gitUserName,
                gitUserEmail: args.gitUserEmail,
                force: args.force,
                timeoutMs: args.timeoutMs,
                workflowId: body.workflow_id,
                nodeId: body.node_id,
                nodeName: body.node_name,
              });
            } else if (isWorkspaceCommand || isBrowserCommand) {
              targetUrl = `${isBrowserCommand ? (workspaceRuntimeUrl ?? functionUrl) : functionUrl}/api/workspaces/command`;
              requestBody = JSON.stringify(
                buildWorkspaceCommandPayload({
                  args,
                  executionId: workspaceExecutionId,
                  dbExecutionId: body.db_execution_id,
                  workflowId: body.workflow_id,
                  nodeId: body.node_id,
                  nodeName: body.node_name,
                }),
              );
            } else if (isWorkspaceMaterializeFiles) {
              targetUrl = `${functionUrl}/api/workspaces/materialize-files`;
              const materializePayload = buildWorkspaceMaterializeFilesPayload({
                args,
                toolId,
                executionId: workspaceExecutionId,
                dbExecutionId: body.db_execution_id,
                workflowId: body.workflow_id,
                nodeId: body.node_id,
                nodeName: body.node_name,
              });
              requestBody = JSON.stringify(materializePayload);
              traceRequestPayload = workspaceMaterializeArgsForSpan(
                "materialize-files",
                materializePayload,
              );
            } else if (isWorkspaceFile) {
              targetUrl = `${functionUrl}/api/workspaces/file`;
              requestBody = JSON.stringify({
                executionId: workspaceExecutionId,
                dbExecutionId: body.db_execution_id ?? undefined,
                workspaceRef: args.workspaceRef,
                operation: args.operation,
                path: args.path,
                content: args.content,
                old_string: args.old_string,
                new_string: args.new_string,
                workflowId: body.workflow_id,
                nodeId: body.node_id,
                nodeName: body.node_name,
              });
            } else if (isWorkspaceCleanup || isBrowserCleanup) {
              targetUrl = `${isBrowserCleanup ? (workspaceRuntimeUrl ?? functionUrl) : functionUrl}/api/workspaces/cleanup`;
              requestBody = JSON.stringify({
                executionId: workspaceExecutionId,
                dbExecutionId: body.db_execution_id ?? undefined,
                workspaceRef: args.workspaceRef,
                workflowId: body.workflow_id,
                nodeId: body.node_id,
                nodeName: body.node_name,
              });
            } else if (isBrowserProfile) {
              targetUrl = `${workspaceRuntimeUrl ?? functionUrl}/api/workspaces/profile`;
              requestBody = JSON.stringify({
                executionId: workspaceExecutionId,
                dbExecutionId: body.db_execution_id ?? undefined,
                name: args.name,
                rootPath: args.rootPath,
                enabledTools: args.enabledTools,
                requireReadBeforeWrite: args.requireReadBeforeWrite,
                commandTimeoutMs: args.commandTimeoutMs,
                sandboxTemplate: args.sandboxTemplate,
                sandboxImage: args.sandboxImage,
                workflowId: body.workflow_id,
                nodeId: body.node_id,
                nodeName: body.node_name,
              });
            } else if (isBrowserMaterializeChangeArtifact) {
              targetUrl = `${workspaceRuntimeUrl ?? functionUrl}/api/browser/materialize-change-artifact`;
              requestBody = JSON.stringify({
                executionId: workspaceExecutionId,
                dbExecutionId: browserDbExecutionId,
                workspaceRef: args.workspaceRef,
                sourceExecutionId: args.sourceExecutionId,
                durableInstanceId: args.durableInstanceId,
                preferredOperation: args.preferredOperation,
                workflowId: browserWorkflowId,
                nodeId: browserNodeId,
                nodeName: browserNodeName,
              });
            } else if (isBrowserCaptureFlow) {
              targetUrl = `${functionUrl}/api/browser/capture-flow`;
              let steps = args.steps;
              if (typeof steps === "string") {
                try {
                  steps = JSON.parse(steps);
                } catch {
                  /* keep string for downstream validation */
                }
              }
              targetUrl = `${functionUrl}/api/browser/capture-flow`;
              requestBody = JSON.stringify({
                executionId: workspaceExecutionId,
                dbExecutionId: browserDbExecutionId,
                workspaceRef: args.workspaceRef,
                baseUrl: args.baseUrl,
                steps,
                captureTrace: args.captureTrace,
                captureVideo: args.captureVideo,
                viewportPreset: args.viewportPreset,
                captureMode: args.captureMode,
                demoTitle: args.demoTitle,
                demoSummary: args.demoSummary,
                annotationPlan:
                  typeof args.annotationPlan === "string"
                    ? (() => {
                        try {
                          return JSON.parse(args.annotationPlan);
                        } catch {
                          return args.annotationPlan;
                        }
                      })()
                    : args.annotationPlan,
                annotationStyle: args.annotationStyle,
                renderAnnotatedVideo: args.renderAnnotatedVideo,
                renderCaptions: args.renderCaptions,
                timeoutMs: args.timeoutMs,
                metadata:
                  typeof args.metadata === "string"
                    ? (() => {
                        try {
                          return JSON.parse(args.metadata);
                        } catch {
                          return undefined;
                        }
                      })()
                    : args.metadata,
                workflowId: browserWorkflowId,
                nodeId: browserNodeId,
                nodeName: browserNodeName,
              });
            } else if (isBrowserValidate) {
              targetUrl = `${functionUrl}/api/browser/validate`;
              let validateSteps = args.steps;
              if (typeof validateSteps === "string") {
                try {
                  validateSteps = JSON.parse(validateSteps);
                } catch {
                  /* keep string for downstream validation */
                }
              }
              requestBody = JSON.stringify({
                executionId: workspaceExecutionId,
                dbExecutionId: browserDbExecutionId,
                workspaceRef: args.workspaceRef,
                sandboxName: args.sandboxName,
                repoPath: args.repoPath,
                installCommand: args.installCommand,
                devServerCommand: args.devServerCommand,
                baseUrl: args.baseUrl,
                steps: validateSteps,
                captureTrace: args.captureTrace,
                captureVideo: args.captureVideo,
                viewportPreset: args.viewportPreset,
                captureMode: args.captureMode,
                demoTitle: args.demoTitle,
                demoSummary: args.demoSummary,
                stepCount: args.stepCount,
                annotationPlan:
                  typeof args.annotationPlan === "string"
                    ? (() => {
                        try {
                          return JSON.parse(args.annotationPlan);
                        } catch {
                          return args.annotationPlan;
                        }
                      })()
                    : args.annotationPlan,
                annotationStyle: args.annotationStyle,
                renderAnnotatedVideo: args.renderAnnotatedVideo,
                renderCaptions: args.renderCaptions,
                metadata:
                  typeof args.metadata === "string"
                    ? (() => {
                        try {
                          return JSON.parse(args.metadata);
                        } catch {
                          return undefined;
                        }
                      })()
                    : args.metadata,
                timeoutMs: args.timeoutMs,
                workflowId: browserWorkflowId,
                nodeId: browserNodeId,
                nodeName: browserNodeName,
              });
            } else if (isBrowserStopPreview) {
              targetUrl = `${functionUrl}/api/workspaces/preview/stop`;
              const previewId =
                typeof args.previewId === "string" &&
                args.previewId.trim().length > 0
                  ? args.previewId.trim()
                  : browserNodeId && workspaceExecutionId
                    ? `${workspaceExecutionId}-${browserNodeId}`
                    : args.workspaceRef;
              requestBody = JSON.stringify({
                previewId,
                workspaceRef: args.workspaceRef,
                workflowId: browserWorkflowId,
                nodeId: browserNodeId,
                nodeName: browserNodeName,
              });
            } else {
              targetUrl = `${functionUrl}/api/tools/${encodeURIComponent(toolId)}`;
              requestBody = JSON.stringify({ args });
            }

            let httpResponse: Response;
            let responseText = "";
            if (isWorkspaceCreatePullRequest) {
              const { createGiteaPullRequest } =
                await import("../core/gitea-repository.js");
              const repositoryOwner =
                typeof args.repositoryOwner === "string"
                  ? args.repositoryOwner.trim()
                  : "";
              const repositoryRepo =
                typeof args.repositoryRepo === "string"
                  ? args.repositoryRepo.trim()
                  : "";
              const repositoryUsername =
                typeof args.repositoryUsername === "string"
                  ? args.repositoryUsername.trim()
                  : undefined;
              const repositoryToken =
                typeof args.repositoryToken === "string"
                  ? args.repositoryToken.trim()
                  : undefined;
              const headBranch =
                typeof args.headBranch === "string"
                  ? args.headBranch.trim()
                  : "";
              const baseBranch =
                typeof args.baseBranch === "string"
                  ? args.baseBranch.trim()
                  : "";
              const title =
                typeof args.title === "string" ? args.title.trim() : "";
              const bodyText =
                typeof args.body === "string" ? args.body.trim() : undefined;
              const prResult = await createGiteaPullRequest({
                repositoryOwner,
                repositoryRepo,
                repositoryUsername,
                repositoryToken,
                headBranch,
                baseBranch,
                title,
                body: bodyText,
              });
              httpResponse = new Response(
                JSON.stringify({
                  text: "Success",
                  ...prResult,
                }),
                {
                  status: 200,
                  headers: {
                    "Content-Type": "application/json",
                  },
                },
              );
              responseText = await httpResponse.text();
            } else {
              console.log(
                `[Execute Route] Dispatching ${functionSlug} to ${targetUrl} with timeout=${requestTimeoutMs}ms`,
              );
              const requestDispatchStartedAt = Date.now();
              const tracedResponse = await postJsonWithContentTrace(
                targetUrl,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    ...forwardedTraceHeaders,
                  },
                  body: requestBody,
                  signal: controller.signal,
                  dispatcher: longRunningAgent,
                },
                {
                  "function.slug": functionSlug,
                  "workflow.id": body.workflow_id,
                  "workflow.node.id": body.node_id,
                  "workflow.node.name": body.node_name,
                  "workflow.execution.id":
                    body.db_execution_id ?? body.execution_id,
                },
                traceRequestPayload,
              );
              httpResponse = tracedResponse.httpResponse;
              responseText = tracedResponse.responseText;
              console.log(
                `[Execute Route] ${functionSlug} received response headers from ${targetUrl} in ${Date.now() - requestDispatchStartedAt}ms`,
              );
            }

            clearTimeout(timeoutId);
            timing.executionMs = Date.now() - executionStartTime;

            const parsed = parseJsonResponse(responseText);
            const parsedMastra =
              parsed && typeof parsed === "object"
                ? (parsed as MastraToolResponse)
                : undefined;
            let resolvedMastra = parsedMastra;
            if (
              isAgentRun &&
              resolvedMastra?.success === false &&
              (isPendingApprovalAgentResult(resolvedMastra) ||
                isPendingApprovalAgentResult(resolvedMastra?.result))
            ) {
              resolvedMastra = {
                ...resolvedMastra,
                success: true,
                status:
                  typeof resolvedMastra.status === "string"
                    ? resolvedMastra.status
                    : "awaiting_approval",
              };
            }
            if (
              !resolvedMastra?.success &&
              parsed &&
              typeof parsed === "object" &&
              (isWorkspaceProfile ||
                isWorkspaceClone ||
                isWorkspacePublishGitea ||
                isWorkspaceCommand ||
                isWorkspaceFile ||
                isWorkspaceCleanup ||
                isBrowserProfile ||
                isBrowserClone ||
                isBrowserCommand ||
                isBrowserCleanup ||
                isBrowserMaterializeChangeArtifact ||
                isBrowserCaptureFlow ||
                isBrowserValidate ||
                isBrowserStopPreview)
            ) {
              resolvedMastra = {
                success: true,
                result: parsed,
                ...(parsed as Record<string, unknown>),
              } as MastraToolResponse;
            }

            if (!httpResponse.ok) {
              const errorFromBody =
                typeof parsedMastra?.error === "string"
                  ? parsedMastra.error
                  : responseText;
              throw new Error(
                `${target.appId} HTTP ${httpResponse.status}: ${errorFromBody.slice(0, 300)}`,
              );
            }

            if (!response && typeof resolvedMastra?.success === "boolean") {
              const allowWorkspaceCommandFailure =
                (isWorkspaceCommand || isBrowserCommand) &&
                parseBooleanInput(args.allowFailure) === true;
              if (!resolvedMastra.success) {
                const nestedFailure = getMastraNestedFailure(
                  pluginId,
                  toolId,
                  resolvedMastra,
                );
                if (allowWorkspaceCommandFailure) {
                  response = {
                    success: true,
                    data: {
                      toolId:
                        typeof resolvedMastra.toolId === "string"
                          ? resolvedMastra.toolId
                          : toolId,
                      result:
                        resolvedMastra.result !== undefined
                          ? resolvedMastra.result
                          : resolvedMastra,
                      ...(resolvedMastra.result &&
                      typeof resolvedMastra.result === "object"
                        ? (resolvedMastra.result as Record<string, unknown>)
                        : {}),
                      allowedFailure: true,
                      originalError:
                        typeof resolvedMastra.error === "string"
                          ? resolvedMastra.error
                          : nestedFailure,
                    },
                    duration_ms: 0,
                  };
                } else if (
                  isNoFileChangeReviewResult(pluginId, toolId, resolvedMastra)
                ) {
                  response = {
                    success: true,
                    data: {
                      toolId:
                        typeof resolvedMastra.toolId === "string"
                          ? resolvedMastra.toolId
                          : toolId,
                      result:
                        resolvedMastra.result !== undefined
                          ? resolvedMastra.result
                          : resolvedMastra,
                      noFileChanges: true,
                      message: "No file changes detected after durable run.",
                    },
                    duration_ms: 0,
                  };
                } else {
                  response = {
                    success: false,
                    data: {
                      toolId:
                        typeof resolvedMastra.toolId === "string"
                          ? resolvedMastra.toolId
                          : toolId,
                      result:
                        resolvedMastra.result !== undefined
                          ? resolvedMastra.result
                          : resolvedMastra,
                      ...(resolvedMastra.result &&
                      typeof resolvedMastra.result === "object"
                        ? (resolvedMastra.result as Record<string, unknown>)
                        : {}),
                    },
                    error:
                      typeof resolvedMastra.error === "string"
                        ? resolvedMastra.error
                        : nestedFailure || `Tool "${toolId}" failed`,
                    duration_ms: 0,
                  };
                }
              } else {
                const nestedFailure = getMastraNestedFailure(
                  pluginId,
                  toolId,
                  resolvedMastra,
                );
                if (nestedFailure && !allowWorkspaceCommandFailure) {
                  response = {
                    success: false,
                    data: {
                      toolId:
                        typeof resolvedMastra.toolId === "string"
                          ? resolvedMastra.toolId
                          : toolId,
                      result:
                        resolvedMastra.result !== undefined
                          ? resolvedMastra.result
                          : resolvedMastra,
                      ...(resolvedMastra.result &&
                      typeof resolvedMastra.result === "object"
                        ? (resolvedMastra.result as Record<string, unknown>)
                        : {}),
                    },
                    error: nestedFailure,
                    duration_ms: 0,
                  };
                } else {
                  response = {
                    success: true,
                    data: {
                      toolId:
                        typeof resolvedMastra.toolId === "string"
                          ? resolvedMastra.toolId
                          : toolId,
                      result:
                        resolvedMastra.result !== undefined
                          ? resolvedMastra.result
                          : resolvedMastra,
                      ...(resolvedMastra.result &&
                      typeof resolvedMastra.result === "object"
                        ? (resolvedMastra.result as Record<string, unknown>)
                        : {}),
                      plan: resolvedMastra.plan,
                      workflowId:
                        typeof resolvedMastra.workflowId === "string"
                          ? resolvedMastra.workflowId
                          : typeof resolvedMastra.workflow_id === "string"
                            ? resolvedMastra.workflow_id
                            : undefined,
                      workspaceRef:
                        typeof (resolvedMastra as Record<string, unknown>)
                          .workspaceRef === "string"
                          ? ((resolvedMastra as Record<string, unknown>)
                              .workspaceRef as string)
                          : undefined,
                      executionId:
                        typeof (resolvedMastra as Record<string, unknown>)
                          .executionId === "string"
                          ? ((resolvedMastra as Record<string, unknown>)
                              .executionId as string)
                          : undefined,
                      rootPath:
                        typeof (resolvedMastra as Record<string, unknown>)
                          .rootPath === "string"
                          ? ((resolvedMastra as Record<string, unknown>)
                              .rootPath as string)
                          : undefined,
                      files: isWorkspaceMaterializeFiles
                        ? workspaceMaterializedFilesFromResponse(resolvedMastra)
                        : undefined,
                      backend:
                        typeof (resolvedMastra as Record<string, unknown>)
                          .backend === "string"
                          ? ((resolvedMastra as Record<string, unknown>)
                              .backend as string)
                          : undefined,
                      sandboxName: resolveSandboxName(resolvedMastra),
                      cleanedWorkspaceRefs: Array.isArray(
                        (resolvedMastra as Record<string, unknown>)
                          .cleanedWorkspaceRefs,
                      )
                        ? ((resolvedMastra as Record<string, unknown>)
                            .cleanedWorkspaceRefs as unknown[])
                        : undefined,
                      status:
                        typeof resolvedMastra.status === "string"
                          ? resolvedMastra.status
                          : undefined,
                      message:
                        typeof resolvedMastra.message === "string"
                          ? resolvedMastra.message
                          : undefined,
                    },
                    duration_ms: 0,
                  };
                }
              }
            } else if (
              !response &&
              resolvedMastra &&
              (typeof resolvedMastra.workflowId === "string" ||
                typeof resolvedMastra.workflow_id === "string")
            ) {
              response = {
                success: true,
                data: {
                  toolId,
                  workflowId:
                    typeof resolvedMastra.workflowId === "string"
                      ? resolvedMastra.workflowId
                      : typeof resolvedMastra.workflow_id === "string"
                        ? resolvedMastra.workflow_id
                        : undefined,
                  plan: resolvedMastra.plan,
                  status:
                    typeof resolvedMastra.status === "string"
                      ? resolvedMastra.status
                      : undefined,
                  message:
                    typeof resolvedMastra.message === "string"
                      ? resolvedMastra.message
                      : undefined,
                },
                duration_ms: 0,
              };
            } else if (!response) {
              throw new Error(
                `Invalid response from ${target.appId}: ${responseText.slice(0, 300)}`,
              );
            }
          } catch (httpError) {
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
            timing.executionMs = Date.now() - executionStartTime;
            if (httpError instanceof Error && httpError.name === "AbortError") {
              console.error(
                `[Execute Route] Timeout invoking ${functionSlug} at ${targetUrl} after ${requestTimeoutMs}ms`,
              );
              response = {
                success: false,
                error: `Request to ${target.appId} (${functionSlug}) timed out after ${requestTimeoutMs}ms`,
                duration_ms: 0,
              };
            } else {
              response = {
                success: false,
                error:
                  httpError instanceof Error
                    ? httpError.message
                    : `Failed to invoke ${target.appId}`,
                duration_ms: 0,
              };
            }
          }
        } else {
          const isCodeRoute =
            target.appId === "code-runtime" || pluginId === "code";
          const parsedConnectionExternalId =
            parseConnectionExternalIdFromAuthTemplate(body.input?.auth);
          const connectionExternalId =
            body.connection_external_id || parsedConnectionExternalId;

          // Normalize system/* inputs so older saved workflows and/or AI-generated
          // configs don't fail strict fn-system validation.
          let normalizedInput = body.input as Record<string, unknown>;
          if (pluginId === "system" && stepName === "http-request") {
            const normalized = normalizeSystemHttpRequestInput(normalizedInput);
            normalizedInput = normalized.input;

            if (normalized.error) {
              const duration_ms = Date.now() - startTime;
              const response: ExecuteResponse = {
                success: false,
                error: normalized.error,
                duration_ms,
                routed_to: target.appId,
              };

              console.warn(
                `[Execute Route] Validation failed before invoking fn-system: ${normalized.error}`,
              );

              if (logId && body.db_execution_id) {
                try {
                  await logExecutionComplete(logId, {
                    success: false,
                    error: normalized.error,
                    durationMs: duration_ms,
                    timing,
                  });
                } catch (logError) {
                  console.error(
                    "[Execute Route] Failed to log execution completion:",
                    logError,
                  );
                }
              }

              return reply.status(200).send(response);
            }
          } else if (
            pluginId === "system" &&
            isPlainObject(normalizedInput.configFields)
          ) {
            normalizedInput = {
              ...normalizedInput,
              ...normalizedInput.configFields,
            };
          }

          if (isCodeRoute) {
            let runtimeRequest:
              | {
                  language: "typescript" | "python";
                  source: string;
                  entrypoint: string;
                  path: string | null;
                  supporting_files: Record<string, string>;
                  args: unknown[];
                  dependencies: string[];
                }
              | undefined;
            try {
              runtimeRequest = (
                await resolveCodeFunctionExecution(normalizedInput)
              ).runtimeRequest;
            } catch (codeError) {
              timing.executionMs = 0;
              response = {
                success: false,
                error:
                  codeError instanceof Error
                    ? codeError.message
                    : "Failed to resolve saved code function",
                duration_ms: 0,
              };
            }

            if (runtimeRequest) {
              console.log(
                `[Execute Route] Invoking code runtime for ${functionSlug} at ${functionUrl} (routing: ${timing.routingMs}ms)`,
              );
              const controller = new AbortController();
              const timeoutId = setTimeout(
                () => controller.abort(),
                HTTP_TIMEOUT_MS,
              );
              const executionStartTime = Date.now();

              try {
                const tracedResponse = await postJsonWithContentTrace(
                  `${functionUrl}/execute`,
                  {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      ...forwardedTraceHeaders,
                    },
                    body: JSON.stringify(runtimeRequest),
                    signal: controller.signal,
                    dispatcher: longRunningAgent,
                  },
                  {
                    "function.slug": functionSlug,
                    "function.target.app_id": target.appId,
                    "workflow.id": body.workflow_id,
                    "workflow.node.id": body.node_id,
                    "workflow.node.name": body.node_name,
                    "workflow.execution.id":
                      body.db_execution_id ?? body.execution_id,
                  },
                );
                const httpResponse = tracedResponse.httpResponse;

                clearTimeout(timeoutId);
                timing.executionMs = Date.now() - executionStartTime;

                const responseText = tracedResponse.responseText;
                const parsed = parseJsonResponse(responseText);

                if (isPlainObject(parsed)) {
                  const normalizedResponse =
                    normalizeKnativeExecuteResponse(parsed);
                  if (normalizedResponse) {
                    response = normalizedResponse;
                  } else if (httpResponse.ok) {
                    throw new Error(
                      `Invalid JSON response from ${target.appId}: ${responseText.slice(0, 200)}`,
                    );
                  } else {
                    throw new Error(
                      `HTTP ${httpResponse.status}: ${responseText}`,
                    );
                  }
                } else if (httpResponse.ok) {
                  throw new Error(
                    `Invalid JSON response from ${target.appId}: ${responseText.slice(0, 200)}`,
                  );
                } else {
                  throw new Error(
                    `HTTP ${httpResponse.status}: ${responseText}`,
                  );
                }
              } catch (httpError) {
                clearTimeout(timeoutId);
                timing.executionMs = Date.now() - executionStartTime;
                if (
                  httpError instanceof Error &&
                  httpError.name === "AbortError"
                ) {
                  throw new Error(
                    `Request to ${target.appId} timed out after ${HTTP_TIMEOUT_MS}ms`,
                  );
                }
                throw httpError;
              }
            }
          } else {
            // Pre-fetch credentials (non-AP routes only). AP routes use
            // REFERENCE-FORWARDING: the router never touches plaintext — it
            // forwards X-Connection-External-Id and the piece-runtime
            // self-resolves at point of use via the BFF decrypt endpoint
            // (the same path its MCP tools use). The router writes an
            // audit-only credential_access_logs row to preserve the
            // execution↔connection linkage.
            const credentialStartTime = Date.now();
            let credentials: Record<string, string> = {};

            const apContext =
              body.ap_project_id && body.ap_platform_id
                ? {
                    projectId: body.ap_project_id,
                    platformId: body.ap_platform_id,
                  }
                : undefined;

            if (isApRoute) {
              if (connectionExternalId) {
                if (body.db_execution_id) {
                  await logCredentialReferenceForward(
                    body.db_execution_id,
                    body.node_id,
                    pluginId,
                    connectionExternalId,
                  );
                }
                console.log(
                  `[Execute Route] AP reference-forwarding for ${functionSlug}: connection=${connectionExternalId}`,
                );
              } else {
                console.warn(
                  `[Execute Route] AP route ${functionSlug} has no connectionExternalId — auth-requiring actions will fail`,
                );
              }
            } else {
              const credentialResult = await fetchCredentialsWithAudit(
                pluginId,
                body.integrations,
                body.db_execution_id
                  ? {
                      executionId: body.db_execution_id,
                      nodeId: body.node_id,
                    }
                  : undefined,
                connectionExternalId,
                apContext,
              );
              credentials = credentialResult.credentials;
              console.log(
                `[Execute Route] Credentials fetched (source: ${credentialResult.source})`,
              );
            }
            timing.credentialFetchMs = Date.now() - credentialStartTime;

            const knativeRequest: OpenFunctionRequest = {
              step: isApRoute ? functionSlug : stepName,
              execution_id: body.execution_id,
              workflow_id: body.workflow_id,
              node_id: body.node_id,
              input: normalizedInput,
              node_outputs: body.node_outputs,
              ...(isApRoute
                ? {
                    metadata: {
                      pieceName: pluginId,
                      actionName: stepName,
                    },
                    db_execution_id: body.db_execution_id ?? undefined,
                    idempotency_key: body.idempotency_key ?? undefined,
                    execution_type: body.execution_type,
                    resume_payload: body.resume_payload,
                    skip_idempotency_gate: body.skip_idempotency_gate,
                  }
                : { credentials }),
            };
            const requestBody = JSON.stringify(knativeRequest);

            console.log(
              `[Execute Route] Invoking Knative function ${target.appId} step: ${stepName} at ${functionUrl} (routing: ${timing.routingMs}ms)`,
            );
            const requestPath = "/execute";
            const requestTimeoutMs = HTTP_TIMEOUT_MS;

            // Make direct HTTP call to the Knative service
            const controller = new AbortController();
            const timeoutId = setTimeout(
              () => controller.abort(),
              requestTimeoutMs,
            );

            const executionStartTime = Date.now();
            console.log(
              `[Execute Route] HTTP timeout budget for ${target.appId}: ${requestTimeoutMs}ms`,
            );
            try {
              const tracedResponse = await postJsonWithContentTrace(
                `${functionUrl}${requestPath}`,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    ...forwardedTraceHeaders,
                    // Reference-forwarding: the piece-runtime resolves the
                    // connection at point of use (BFF decrypt endpoint).
                    ...(isApRoute && connectionExternalId
                      ? {
                          "X-Connection-External-Id": connectionExternalId,
                        }
                      : {}),
                  },
                  body: requestBody,
                  signal: controller.signal,
                  dispatcher: longRunningAgent,
                },
                {
                  "function.slug": functionSlug,
                  "function.target.app_id": target.appId,
                  "workflow.id": body.workflow_id,
                  "workflow.node.id": body.node_id,
                  "workflow.node.name": body.node_name,
                  "workflow.execution.id":
                    body.db_execution_id ?? body.execution_id,
                },
              );
              const httpResponse = tracedResponse.httpResponse;

              clearTimeout(timeoutId);
              timing.executionMs = Date.now() - executionStartTime;

              // IMPORTANT:
              // OpenFunctions use HTTP status codes inconsistently (some return 5xx
              // for a handled action failure). We always try to parse the JSON
              // response and propagate it back to the orchestrator as a normal
              // (HTTP 200) function-router response, so the orchestrator can surface
              // `error` instead of failing with RequestException.
              const responseText = tracedResponse.responseText;
              const parsed = parseJsonResponse(responseText);

              if (isPlainObject(parsed)) {
                const normalizedResponse =
                  normalizeKnativeExecuteResponse(parsed);
                if (normalizedResponse) {
                  response = normalizedResponse;
                } else if (httpResponse.ok) {
                  throw new Error(
                    `Invalid JSON response from ${target.appId}: ${responseText.slice(0, 200)}`,
                  );
                } else {
                  throw new Error(
                    `HTTP ${httpResponse.status}: ${responseText}`,
                  );
                }
              } else if (httpResponse.ok) {
                throw new Error(
                  `Invalid JSON response from ${target.appId}: ${responseText.slice(0, 200)}`,
                );
              } else {
                throw new Error(`HTTP ${httpResponse.status}: ${responseText}`);
              }
            } catch (httpError) {
              clearTimeout(timeoutId);
              timing.executionMs = Date.now() - executionStartTime;
              if (
                httpError instanceof Error &&
                httpError.name === "AbortError"
              ) {
                throw new Error(
                  `Request to ${target.appId} timed out after ${requestTimeoutMs}ms`,
                );
              }
              throw httpError;
            }
          }
        }

        if (!response) {
          throw new Error(`No execution response produced for ${functionSlug}`);
        }

        const executionMs = timing.executionMs ?? 0;

        // Cold start detection
        const avgResponseTime = getResponseTimeAverage(target.appId);
        if (
          avgResponseTime > 0 &&
          executionMs > avgResponseTime * COLD_START_MULTIPLIER
        ) {
          timing.wasColdStart = true;
          timing.coldStartMs = executionMs - avgResponseTime;
          console.log(
            `[Execute Route] Cold start detected for ${target.appId}: ${executionMs}ms vs avg ${avgResponseTime}ms`,
          );
        } else {
          timing.wasColdStart = false;
        }

        // Record response time for future cold start detection
        recordResponseTime(target.appId, executionMs);

        response.routed_to = target.appId;
      } else {
        // Route to function-runner (builtin fallback)
        console.log(
          "[Execute Route] Routing to function-runner for builtin execution",
        );

        const executionStartTime = Date.now();
        const result = await client.invoker.invoke(
          target.appId,
          "execute",
          HttpMethod.POST,
          body,
        );
        timing.executionMs = Date.now() - executionStartTime;

        response = result as ExecuteResponse;
        response.routed_to = target.appId;
      }

      const duration_ms = Date.now() - startTime;
      response.duration_ms = duration_ms;

      console.log(
        `[Execute Route] Function ${functionSlug} completed via ${target.appId}: success=${response.success}, duration=${duration_ms}ms` +
          (timing.wasColdStart ? " (cold start)" : ""),
      );

      // Log execution completion (only if we started logging)
      if (logId && body.db_execution_id) {
        try {
          await logExecutionComplete(logId, {
            success: response.success,
            output: response.data ?? response,
            error: response.error,
            durationMs: duration_ms,
            timing,
          });
        } catch (logError) {
          console.error(
            "[Execute Route] Failed to log execution completion:",
            logError,
          );
        }
      }

      // Always return 200 for a successfully routed call, even when the function
      // reports `success: false`. The workflow-orchestrator uses `raise_for_status`
      // and would otherwise drop the actionable error message.
      return reply.status(200).send(response);
    } catch (error) {
      const duration_ms = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      console.error(
        `[Execute Route] Failed to route ${functionSlug} to ${target.appId}:`,
        error,
      );

      // Log execution failure (only if we started logging)
      if (logId && body.db_execution_id) {
        try {
          await logExecutionComplete(logId, {
            success: false,
            error: `Function routing failed: ${errorMessage}`,
            durationMs: duration_ms,
            timing,
          });
        } catch (logError) {
          console.error(
            "[Execute Route] Failed to log execution failure:",
            logError,
          );
        }
      }

      return reply.status(500).send({
        success: false,
        error: `Function routing failed: ${errorMessage}`,
        duration_ms,
        routed_to: target.appId,
      } as ExecuteResponse);
    }
  });

  /**
   * GET /registry - List current function registry (for debugging)
   */
  app.get("/registry", async (_request, reply) => {
    const { loadRegistry } = await import("../core/registry.js");
    const registry = await loadRegistry();

    return reply.status(200).send({
      success: true,
      registry,
      count: Object.keys(registry).length,
    });
  });
}
// retrigger build for workspace/command GITHUB_TOKEN injection

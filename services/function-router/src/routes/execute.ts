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

import { DaprClient, HttpMethod } from "@dapr/dapr";
import type { FastifyInstance } from "fastify";
import { fetch as undiciFetch, Agent as UndiciAgent, Pool } from "undici";
import { z } from "zod";

const longRunningAgent = new UndiciAgent({
  factory: (origin, opts) =>
    new Pool(origin, { ...opts, bodyTimeout: 0, headersTimeout: 0 }),
});
import {
  fetchCredentialsWithAudit,
  fetchRawConnectionValue,
} from "../core/credential-service.js";
import { resolveCodeFunctionExecution } from "../core/code-functions.js";
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
import { lookupFunction } from "../core/registry.js";
import {
  bindWorkflowSessionContext,
  buildWorkflowSessionId,
  sessionIdFromHeaders,
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
const AGENT_HTTP_TIMEOUT_BUFFER_MS = 30_000;
const MIN_AGENT_HTTP_TIMEOUT_MS = 90_000;
const MAX_AGENT_HTTP_TIMEOUT_MS = 7_200_000;
const DEFAULT_WORKSPACE_UTILITY_TIMEOUT_MS = 30_000;
const DEFAULT_WORKSPACE_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_WORKSPACE_CLONE_TIMEOUT_MS = 300_000;
const MAX_WORKSPACE_UTILITY_TIMEOUT_MS = 3_600_000;
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

function resolveDaprSweHttpTimeoutMs(input: {
  timeoutMinutes: unknown;
  timeoutMs: unknown;
}): number {
  const explicitTimeoutMs = asNumber(input.timeoutMs);
  if (explicitTimeoutMs !== undefined) {
    return clampTimeoutMs(explicitTimeoutMs + AGENT_HTTP_TIMEOUT_BUFFER_MS, {
      min: MIN_AGENT_HTTP_TIMEOUT_MS,
      max: MAX_AGENT_HTTP_TIMEOUT_MS,
    });
  }
  return resolveAgentHttpTimeoutMs(input.timeoutMinutes);
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

  return {
    success,
    data: fallbackData,
    error,
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
    return { type: "stepCountIs", maxSteps: Math.max(1, Math.floor(maxSteps)) };
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
    const resolvedSessionId =
      buildWorkflowSessionId(body.db_execution_id || body.execution_id) ||
      sessionIdFromHeaders(request.headers);
    if (resolvedSessionId) {
      bindWorkflowSessionContext(resolvedSessionId);
    }
    const functionSlug = body.function_slug || body.function_id;

    if (!functionSlug) {
      return reply.status(400).send({
        success: false,
        error: "Either function_id or function_slug is required",
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
          const value = request.headers[headerName];
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
          input: body.input,
        });
      } catch (logError) {
        console.error(
          "[Execute Route] Failed to log execution start:",
          logError,
        );
      }
    }

    // Step 1: Look up the target service
    const target = await lookupFunction(functionSlug);
    console.log(
      `[Execute Route] Routing ${functionSlug} to ${target.appId} (${target.type})`,
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
            const isBrowserStartPreview =
              pluginId === "browser" && toolId === "start-preview";
            const isBrowserStopPreview =
              pluginId === "browser" && toolId === "stop-preview";
            const isWorkspaceUtility =
              isWorkspaceProfile ||
              isWorkspaceClone ||
              isWorkspacePublishGitea ||
              isWorkspaceCommand ||
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
              isBrowserStartPreview ||
              isBrowserStopPreview;
            requestTimeoutMs = isBuiltinRuntime
              ? isWorkspaceUtility || isBrowserUtility
                ? resolveWorkspaceUtilityTimeoutMs({
                    toolId,
                    timeoutMs: args.timeoutMs,
                    commandTimeoutMs: args.commandTimeoutMs,
                  }) +
                  (isBrowserCaptureFlow ||
                  isBrowserValidate ||
                  isBrowserStartPreview
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
              isBrowserStartPreview ||
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

              if (!repositoryBranch) {
                throw new Error(
                  "workspace/clone requires repositoryBranch and repository source",
                );
              }

              const resolved = await resolveCloneRepository({
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
                repositoryUsername: resolved.repositoryUsername,
                targetDir: args.targetDir,
                repositoryToken: resolved.repositoryToken,
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
            } else if (isBrowserStartPreview) {
              targetUrl = `${functionUrl}/api/workspaces/preview/start`;
              const previewId =
                typeof args.previewId === "string" &&
                args.previewId.trim().length > 0
                  ? args.previewId.trim()
                  : browserNodeId && workspaceExecutionId
                    ? `${workspaceExecutionId}-${browserNodeId}`
                    : args.workspaceRef;
              requestBody = JSON.stringify({
                executionId: workspaceExecutionId,
                dbExecutionId: browserDbExecutionId,
                workspaceRef: args.workspaceRef,
                sandboxName: args.sandboxName,
                rootPath: args.rootPath,
                workingDir: args.workingDir ?? args.workingDirectory,
                provider: args.provider,
                previewId,
                repoPath: args.repoPath,
                installCommand: args.installCommand,
                devServerCommand: args.devServerCommand,
                baseUrl: args.baseUrl,
                timeoutSeconds: args.timeoutSeconds,
                keepAlive: args.keepAlive,
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
            if (isWorkspaceCreatePullRequest) {
              const { createGiteaPullRequest } = await import(
                "../core/gitea-repository.js"
              );
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
                JSON.stringify({ text: "Success", ...prResult }),
                {
                  status: 200,
                  headers: { "Content-Type": "application/json" },
                },
              );
            } else {
              console.log(
                `[Execute Route] Dispatching ${functionSlug} to ${targetUrl} with timeout=${requestTimeoutMs}ms`,
              );
              const requestDispatchStartedAt = Date.now();
              httpResponse = await undiciFetch(targetUrl, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  ...forwardedTraceHeaders,
                },
                body: requestBody,
                signal: controller.signal,
                dispatcher: longRunningAgent,
              });
              console.log(
                `[Execute Route] ${functionSlug} received response headers from ${targetUrl} in ${Date.now() - requestDispatchStartedAt}ms`,
              );
            }

            clearTimeout(timeoutId);
            timing.executionMs = Date.now() - executionStartTime;

            const responseText = await httpResponse.text();
            const parsed = parseJsonResponse(responseText);
            const parsedMastra =
              parsed && typeof parsed === "object"
                ? (parsed as MastraToolResponse)
                : undefined;
            const parsedWithPreviewRequest =
              isBrowserStartPreview && parsed && typeof parsed === "object"
                ? {
                    ...(parsed as Record<string, unknown>),
                    requestedRepoPath:
                      typeof args.repoPath === "string"
                        ? args.repoPath.trim()
                        : undefined,
                    requestedBaseUrl:
                      typeof args.baseUrl === "string"
                        ? args.baseUrl.trim()
                        : undefined,
                    requestedDevServerCommand:
                      typeof args.devServerCommand === "string"
                        ? args.devServerCommand.trim()
                        : undefined,
                    requestedInstallCommand:
                      typeof args.installCommand === "string"
                        ? args.installCommand.trim()
                        : undefined,
                  }
                : parsed;
            let resolvedMastra =
              isBrowserStartPreview &&
              parsedWithPreviewRequest &&
              typeof parsedWithPreviewRequest === "object"
                ? (parsedWithPreviewRequest as MastraToolResponse)
                : parsedMastra;
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
                isBrowserStartPreview ||
                isBrowserStopPreview)
            ) {
              resolvedMastra = {
                success: true,
                result: parsedWithPreviewRequest,
                ...(parsedWithPreviewRequest as Record<string, unknown>),
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
          const isApRoute = target.appId === "fn-activepieces";
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
                const httpResponse = await undiciFetch(
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
                );

                clearTimeout(timeoutId);
                timing.executionMs = Date.now() - executionStartTime;

                const responseText = await httpResponse.text();
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
            // Pre-fetch credentials
            const credentialStartTime = Date.now();
            let credentialsRaw: unknown | undefined;

            const apContext =
              body.ap_project_id && body.ap_platform_id
                ? {
                    projectId: body.ap_project_id,
                    platformId: body.ap_platform_id,
                  }
                : undefined;

            if (isApRoute && connectionExternalId) {
              // For AP actions: fetch raw connection value (passes directly to context.auth)
              credentialsRaw = await fetchRawConnectionValue(
                connectionExternalId,
                apContext,
              );
              console.log(
                `[Execute Route] AP credentials_raw for ${functionSlug}: ` +
                  `type=${(credentialsRaw as Record<string, unknown>)?.type ?? "null"}, ` +
                  `hasAccessToken=${!!(credentialsRaw as Record<string, unknown>)?.access_token}`,
              );
            } else if (isApRoute) {
              console.warn(
                `[Execute Route] AP route ${functionSlug} has no connectionExternalId — auth will fail`,
              );
            }

            // Always fetch env-var-mapped credentials too (for native services and as fallback)
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
            timing.credentialFetchMs = Date.now() - credentialStartTime;

            console.log(
              `[Execute Route] Credentials fetched in ${timing.credentialFetchMs}ms (source: ${credentialResult.source})`,
            );

            const knativeRequest: OpenFunctionRequest = {
              step: isApRoute ? functionSlug : stepName,
              execution_id: body.execution_id,
              workflow_id: body.workflow_id,
              node_id: body.node_id,
              input: normalizedInput,
              node_outputs: body.node_outputs,
              credentials: credentialResult.credentials,
              ...(isApRoute && {
                credentials_raw: credentialsRaw,
                metadata: { pieceName: pluginId, actionName: stepName },
              }),
            };
            const requestBody = JSON.stringify(knativeRequest);

            console.log(
              `[Execute Route] Invoking Knative function ${target.appId} step: ${stepName} at ${functionUrl} (routing: ${timing.routingMs}ms)`,
            );
            const requestPath = "/execute";
            const requestTimeoutMs =
              target.appId === "dapr-swe"
                ? resolveDaprSweHttpTimeoutMs({
                    timeoutMinutes:
                      isPlainObject(normalizedInput) &&
                      typeof normalizedInput.timeoutMinutes !== "undefined"
                        ? normalizedInput.timeoutMinutes
                        : undefined,
                    timeoutMs:
                      isPlainObject(normalizedInput) &&
                      typeof normalizedInput.timeoutMs !== "undefined"
                        ? normalizedInput.timeoutMs
                        : undefined,
                  })
                : HTTP_TIMEOUT_MS;

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
              const httpResponse = await undiciFetch(
                `${functionUrl}${requestPath}`,
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
              );

              clearTimeout(timeoutId);
              timing.executionMs = Date.now() - executionStartTime;

              // IMPORTANT:
              // OpenFunctions use HTTP status codes inconsistently (some return 5xx
              // for a handled action failure). We always try to parse the JSON
              // response and propagate it back to the orchestrator as a normal
              // (HTTP 200) function-router response, so the orchestrator can surface
              // `error` instead of failing with RequestException.
              const responseText = await httpResponse.text();
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

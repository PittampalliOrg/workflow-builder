/** Workspace-scoped workflow execution debugging tools. */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  diagnosticStatus,
  normalizeDiagnosticTelemetry,
  type DiagnosticTelemetry,
} from "./application/diagnostic-telemetry.js";
import type { WorkflowDiagnosticsUseCases } from "./application/workflow-diagnostics.js";
import {
  hasWorkflowMcpScope,
  type WorkflowMcpPrincipal,
} from "./auth-context.js";
import {
  diagnosticEnvelopeTraceMetadata,
  setSpanOutput,
} from "./observability/content.js";
import type { RegisteredTool } from "./workflow-tools.js";

type NextAction = {
  tool: string;
  arguments: Record<string, unknown>;
  reason: string;
};

type DiagnosticEnvelope = {
  ok: boolean;
  observedAt: string;
  telemetry: DiagnosticTelemetry;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
  nextActions: NextAction[];
};

const OUTPUT_SCHEMA = {
  ok: z.boolean(),
  observedAt: z.string(),
  telemetry: z.object({
    state: z.enum(["complete", "partial", "pending", "unavailable"]),
    isFinal: z.boolean(),
    warnings: z.array(z.string()),
    refreshAfterMs: z.number().int().positive().optional(),
  }),
  data: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
    })
    .optional(),
  nextActions: z.array(
    z.object({
      tool: z.string(),
      arguments: z.record(z.unknown()),
      reason: z.string(),
    }),
  ),
};

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function result(
  data: unknown,
  options: {
    tool: string;
    warnings?: string[];
    nextActions?: NextAction[];
    status?: string | null;
  },
) {
  const envelope: DiagnosticEnvelope = {
    ok: true,
    observedAt: new Date().toISOString(),
    telemetry: normalizeDiagnosticTelemetry(data, {
      status: options.status,
      warnings: options.warnings,
    }),
    data,
    nextActions: options.nextActions ?? [],
  };
  setSpanOutput(diagnosticEnvelopeTraceMetadata(envelope, options.tool));
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(envelope, null, 2) },
    ],
    structuredContent: envelope,
  };
}

function errorResult(
  tool: string,
  error: unknown,
  nextActions: NextAction[] = [],
) {
  const source = record(error);
  const status = typeof source?.status === "number" ? source.status : 500;
  const code =
    typeof source?.code === "string" ? source.code : "diagnostics_failed";
  const message = error instanceof Error ? error.message : String(error);
  const retryable = status === 429 || status >= 500;
  const envelope: DiagnosticEnvelope = {
    ok: false,
    observedAt: new Date().toISOString(),
    telemetry: {
      state: "unavailable",
      isFinal: !retryable,
      warnings: [message],
      ...(retryable ? { refreshAfterMs: 5_000 } : {}),
    },
    error: { code, message, retryable },
    nextActions,
  };
  setSpanOutput(diagnosticEnvelopeTraceMetadata(envelope, tool));
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(envelope, null, 2) },
    ],
    structuredContent: envelope,
    isError: true,
  };
}

function firstRecord(
  value: unknown,
  key: string,
): Record<string, unknown> | null {
  const rows = record(value)?.[key];
  return Array.isArray(rows) ? record(rows[0]) : null;
}

function records(value: unknown, key: string): Record<string, unknown>[] {
  const rows = record(value)?.[key];
  return Array.isArray(rows)
    ? rows
        .map(record)
        .filter((item): item is Record<string, unknown> => item !== null)
    : [];
}

function pageCursor(value: unknown): string | null {
  const cursor = record(record(value)?.page)?.nextCursor;
  return typeof cursor === "string" && cursor.length > 0 ? cursor : null;
}

function definedArguments(
  args: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter(([, value]) => value !== undefined),
  );
}

function continuationAction(
  tool: string,
  args: Record<string, unknown>,
  data: unknown,
  reason: string,
): NextAction | null {
  const cursor = pageCursor(data);
  return cursor
    ? {
        tool,
        arguments: definedArguments({ ...args, cursor }),
        reason,
      }
    : null;
}

const LLM_SPAN_RE =
  /(^|[.:/_ -])(llm|gen[_ -]?ai|chat(?:[_ -]?completion)?|completion|invoke[_ -]?model|model[_ -]?invoke|openai|anthropic|gemini|kimi|moonshot)(?:$|[.:/_ -])/i;

function declaredOpenInferenceKind(
  span: Record<string, unknown>,
  attributes: Record<string, unknown> | null,
): string | null {
  const attributeKind = attributes?.["openinference.span.kind"];
  if (typeof attributeKind === "string" && attributeKind.trim()) {
    return attributeKind.trim().toUpperCase();
  }
  const flattenedKind = span.kind;
  if (
    typeof flattenedKind === "string" &&
    [
      "AGENT",
      "CHAIN",
      "EMBEDDING",
      "EVALUATOR",
      "GUARDRAIL",
      "LLM",
      "RERANKER",
      "RETRIEVER",
      "TOOL",
    ].includes(flattenedKind.trim().toUpperCase())
  ) {
    return flattenedKind.trim().toUpperCase();
  }
  return null;
}

function looksLlmRelated(value: unknown): boolean {
  const span = record(value);
  if (!span) return false;
  const attributes = record(span.attributes);
  const declaredKind = declaredOpenInferenceKind(span, attributes);
  if (declaredKind) return declaredKind === "LLM";
  if (
    attributes &&
    Object.keys(attributes).some((key) =>
      /^(gen_ai|llm|openinference)[._-]/i.test(key),
    )
  ) {
    return true;
  }
  if (
    typeof span.model === "string" ||
    typeof span.provider === "string" ||
    typeof span.promptTokens === "number"
  ) {
    return true;
  }
  return [span.name, span.service, span.kind].some(
    (item) => typeof item === "string" && LLM_SPAN_RE.test(item),
  );
}

function llmTurnArguments(
  executionId: string,
  _span: unknown,
  spanId: string,
): Record<string, unknown> {
  // Prefer the concrete spanId: a span's session.id attribute may be the
  // k8s-label-sanitized form daprd/collector stamp (lowercased + truncated
  // to 63 chars), which never matches the full session ids the curated
  // obs.llm_spans view stores — a sessionId lookup built from it returns
  // empty. Session-wide paging stays available to callers that hold a real
  // session id (e.g. from the digest's `sessions` list).
  return { executionId, spanId };
}

function screenshotStorageRefs(value: unknown): string[] {
  const refs = new Set<string>();
  for (const artifact of records(value, "browserArtifacts")) {
    for (const asset of records(artifact, "assets")) {
      if (
        asset.kind === "screenshot" &&
        typeof asset.storageRef === "string" &&
        asset.storageRef.length > 0
      ) {
        refs.add(asset.storageRef);
      }
    }
  }
  return [...refs].slice(0, 6);
}

function hasDigestIssues(value: unknown): boolean {
  const issues = record(value)?.issues;
  return Array.isArray(issues) && issues.length > 0;
}

function isSuccessfulExecutionStatus(status: string | null): boolean {
  return ["success", "succeeded", "completed"].includes(
    status?.toLowerCase() ?? "",
  );
}

function executionNextActions(
  executionId: string,
  diagnostic: unknown,
): NextAction[] {
  const root = record(diagnostic);
  const actions: NextAction[] = [];
  const status = diagnosticStatus(root?.overview);
  if (status === "running" || status === "pending") {
    actions.push({
      tool: "debug_workflow_execution",
      arguments: { executionId },
      reason:
        "The execution is still active; refresh after telemetry has advanced.",
    });
  }
  actions.push({
    tool: "trace_get_tree",
    arguments: { executionId },
    reason:
      "See the run's structural waterfall (every phase/activity/agent span) in one bounded read.",
  });
  // Error-status spans can describe expected retries, probes, or idempotent
  // cleanup. Keep them in the returned evidence, but only promote them as the
  // next debugging target when the run did not succeed or its digest found an
  // evidence-backed issue.
  const shouldInvestigateErrors =
    !isSuccessfulExecutionStatus(status) || hasDigestIssues(root?.digest);
  const spans = shouldInvestigateErrors
    ? firstRecord(root?.errorSpans, "spans")
    : null;
  if (typeof spans?.spanId === "string") {
    actions.push({
      tool: "trace_get_span",
      arguments: { executionId, spanId: spans.spanId },
      reason:
        "Inspect the first failing span's bounded attributes and runtime evidence.",
    });
    actions.push({
      tool: "trace_get_logs",
      arguments: { executionId, spanId: spans.spanId, errorsOnly: true },
      reason: "Inspect logs correlated with the first failing span.",
    });
    if (looksLlmRelated(spans)) {
      actions.push({
        tool: "trace_get_llm_turn",
        arguments: { executionId, spanId: spans.spanId },
        reason:
          "Inspect the prompt and response for this LLM-related failing span.",
      });
    }
  }
  for (const storageRef of screenshotStorageRefs(root?.overview)) {
    actions.push({
      tool: "trace_get_browser_screenshot",
      arguments: { executionId, storageRef },
      reason:
        "Inspect the captured browser pixels with the model's vision capability.",
    });
  }
  if (shouldInvestigateErrors) {
    const spanContinuation = continuationAction(
      "trace_search_spans",
      { executionId, errorsOnly: true, limit: 20 },
      root?.errorSpans,
      "Continue the failing-span search from the server-issued cursor.",
    );
    if (spanContinuation) actions.push(spanContinuation);
    const logContinuation = continuationAction(
      "trace_get_logs",
      { executionId, errorsOnly: true, limit: 40 },
      root?.errorLogs,
      "Continue the error-log search from the server-issued cursor.",
    );
    if (logContinuation) actions.push(logContinuation);
    if (!spans) {
      actions.push({
        tool: "trace_search_spans",
        arguments: { executionId, errorsOnly: true, limit: 40 },
        reason:
          "Search for failing spans when the bounded first pass returned none.",
      });
    }
  }
  return actions;
}

export type TraceToolsContext = {
  diagnostics: WorkflowDiagnosticsUseCases;
  principal?: WorkflowMcpPrincipal | null;
};

export function registerTraceTools(
  server: McpServer,
  context: TraceToolsContext,
): RegisteredTool[] {
  if (!hasWorkflowMcpScope(context.principal, "workflow:read")) return [];

  const tools: RegisteredTool[] = [];
  const register = (
    name: string,
    description: string,
    config: Record<string, unknown>,
    handler: (args: any) => Promise<unknown>,
  ) => {
    (server as any).registerTool(
      name,
      {
        ...config,
        description,
        outputSchema: OUTPUT_SCHEMA,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      handler,
    );
    tools.push({ name, description });
  };

  register(
    "list_workflow_executions",
    "List recent executions in the authenticated workspace. Filter by workflow id or exact workflow name, then pass an executionId to debug_workflow_execution. No sessionId is needed.",
    {
      title: "List Workflow Executions",
      inputSchema: {
        workflowId: z.string().min(1).optional(),
        workflowName: z.string().min(1).optional(),
        status: z
          .enum(["pending", "running", "success", "error", "cancelled"])
          .optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
      },
    },
    async (args: {
      workflowId?: string;
      workflowName?: string;
      status?: "pending" | "running" | "success" | "error" | "cancelled";
      limit?: number;
      cursor?: string;
    }) => {
      try {
        const data = await context.diagnostics.listWorkflowExecutions(args);
        const executions = records(data, "executions");
        const nextActions: NextAction[] = [];
        if (executions.length === 1) {
          const executionId =
            typeof executions[0].executionId === "string"
              ? executions[0].executionId
              : typeof executions[0].id === "string"
                ? executions[0].id
                : null;
          if (executionId) {
            nextActions.push({
              tool: "debug_workflow_execution",
              arguments: { executionId },
              reason:
                "Inspect the single execution returned by this filtered page.",
            });
          }
        }
        const continuation = continuationAction(
          "list_workflow_executions",
          args,
          data,
          "Continue listing executions from the server-issued cursor.",
        );
        if (continuation) nextActions.push(continuation);
        return result(data, {
          tool: "list_workflow_executions",
          nextActions,
        });
      } catch (error) {
        return errorResult("list_workflow_executions", error);
      }
    },
  );

  register(
    "debug_workflow_execution",
    "Best first call for a known execution: returns a bounded execution overview, deterministic digest, failing spans, error logs, evidence coverage, and exact drill-down suggestions.",
    {
      title: "Debug Workflow Execution",
      inputSchema: {
        executionId: z.string().min(6).describe("Workflow execution id"),
      },
    },
    async ({ executionId }: { executionId: string }) => {
      try {
        const data =
          await context.diagnostics.debugWorkflowExecution(executionId);
        return result(data, {
          tool: "debug_workflow_execution",
          status: diagnosticStatus(data.overview),
          nextActions: executionNextActions(executionId, data),
        });
      } catch (error) {
        return errorResult("debug_workflow_execution", error, [
          {
            tool: "list_workflow_executions",
            arguments: {},
            reason:
              "Confirm the execution identifier and its workspace ownership.",
          },
        ]);
      }
    },
  );

  register(
    "trace_get_digest",
    "Get the deterministic run digest: phases, latency, tokens/cost, cache use, critical path, budget burn, and evidence-backed issues. Use after debug_workflow_execution when you need the complete digest projection.",
    {
      title: "Get Run Digest",
      inputSchema: {
        executionId: z.string().min(6).describe("Workflow execution id"),
      },
    },
    async ({ executionId }: { executionId: string }) => {
      try {
        return result(await context.diagnostics.getDigest(executionId), {
          tool: "trace_get_digest",
          nextActions: [
            {
              tool: "trace_search_spans",
              arguments: { executionId, errorsOnly: true },
              reason: "Locate concrete failing spans behind digest issues.",
            },
          ],
        });
      } catch (error) {
        return errorResult("trace_get_digest", error);
      }
    },
  );

  register(
    "trace_search_spans",
    "Search execution-scoped spans by operation, service, status message, or session id; `service` filters to one exact service name (e.g. an agent runtime) so plumbing spans don't crowd the page. Results are bounded and paginated; use returned span ids for span/LLM-turn/log evidence, and prefer trace_get_tree first when you want the run's overall shape.",
    {
      title: "Search Trace Spans",
      inputSchema: {
        executionId: z.string().min(6),
        query: z.string().optional(),
        errorsOnly: z.boolean().optional(),
        service: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
      },
    },
    async (args: {
      executionId: string;
      query?: string;
      errorsOnly?: boolean;
      service?: string;
      limit?: number;
      cursor?: string;
    }) => {
      try {
        const data = await context.diagnostics.searchSpans(
          args.executionId,
          args,
        );
        const first = firstRecord(data, "spans");
        const nextActions: NextAction[] = [];
        if (typeof first?.spanId === "string") {
          nextActions.push({
            tool: "trace_get_span",
            arguments: { executionId: args.executionId, spanId: first.spanId },
            reason:
              "Inspect bounded generic span attributes and tool/MCP input-output evidence.",
          });
          if (looksLlmRelated(first)) {
            nextActions.push({
              tool: "trace_get_llm_turn",
              arguments: llmTurnArguments(
                args.executionId,
                first,
                first.spanId,
              ),
              reason:
                "Inspect the exact prompt and response for this LLM-related span.",
            });
          }
        }
        const continuation = continuationAction(
          "trace_search_spans",
          args,
          data,
          "Continue the span search from the server-issued cursor.",
        );
        if (continuation) nextActions.push(continuation);
        return result(data, { tool: "trace_search_spans", nextActions });
      } catch (error) {
        return errorResult("trace_search_spans", error);
      }
    },
  );

  register(
    "trace_get_span",
    "Get one exact execution-scoped span, including bounded and redacted attributes. Use this for tool, MCP, HTTP, database, and runtime spans that are not LLM turns.",
    {
      title: "Get Trace Span Detail",
      inputSchema: {
        executionId: z.string().min(6),
        spanId: z.string().min(1),
      },
    },
    async ({
      executionId,
      spanId,
    }: {
      executionId: string;
      spanId: string;
    }) => {
      try {
        const data = await context.diagnostics.getSpan(executionId, spanId);
        const nextActions: NextAction[] = [
          {
            tool: "trace_get_logs",
            arguments: { executionId, spanId },
            reason: "Correlate the selected span with runtime logs.",
          },
        ];
        const span = record(data)?.span;
        if (looksLlmRelated(span)) {
          nextActions.push({
            tool: "trace_get_llm_turn",
            arguments: llmTurnArguments(executionId, span, spanId),
            reason:
              "Inspect the exact prompt and response for this LLM-related span.",
          });
        }
        return result(data, {
          tool: "trace_get_span",
          nextActions,
        });
      } catch (error) {
        return errorResult("trace_get_span", error);
      }
    },
  );

  register(
    "trace_get_llm_turn",
    "Read exact LLM prompt/response evidence for one span or a bounded page of one child session. Supply exactly one of spanId or sessionId.",
    {
      title: "Get LLM Turn Content",
      inputSchema: {
        executionId: z.string().min(6),
        spanId: z.string().optional(),
        sessionId: z.string().optional(),
        limit: z.number().int().min(1).max(3).optional(),
        cursor: z.string().optional(),
      },
    },
    async (args: {
      executionId: string;
      spanId?: string;
      sessionId?: string;
      limit?: number;
      cursor?: string;
    }) => {
      if (Boolean(args.spanId) === Boolean(args.sessionId)) {
        return errorResult(
          "trace_get_llm_turn",
          Object.assign(
            new Error("Provide exactly one of spanId or sessionId"),
            { status: 400, code: "invalid_trace_selector" },
          ),
        );
      }
      try {
        const data = await context.diagnostics.getLlmTurns(
          args.executionId,
          args,
        );
        const first = firstRecord(data, "turns");
        const nextActions: NextAction[] = [];
        if (typeof first?.spanId === "string") {
          nextActions.push({
            tool: "trace_get_logs",
            arguments: {
              executionId: args.executionId,
              spanId: first.spanId,
            },
            reason: "Correlate this model turn with runtime logs.",
          });
        }
        const continuation = continuationAction(
          "trace_get_llm_turn",
          args,
          data,
          "Continue the child session's LLM-turn page from the server-issued cursor.",
        );
        if (continuation) nextActions.push(continuation);
        return result(data, {
          tool: "trace_get_llm_turn",
          nextActions,
        });
      } catch (error) {
        return errorResult("trace_get_llm_turn", error);
      }
    },
  );

  register(
    "trace_get_tree",
    "Get the execution's compact span waterfall in ONE bounded read: pre-order `nodes` (parent before children) each with depth/name/service/durationMs/status — render as an indented tree. Repetitive same-name siblings are collapsed (omittedChildren counts) and the node count is capped. Best first structural view; drill into specific spanIds with trace_get_span / trace_get_llm_turn / trace_get_tool_calls.",
    {
      title: "Get Span Tree",
      inputSchema: {
        executionId: z.string().min(6),
        maxNodes: z.number().int().min(20).max(800).optional(),
      },
    },
    async ({
      executionId,
      maxNodes,
    }: {
      executionId: string;
      maxNodes?: number;
    }) => {
      try {
        const data = await context.diagnostics.getSpanTree(
          executionId,
          maxNodes,
        );
        return result(data, {
          tool: "trace_get_tree",
          nextActions: [
            {
              tool: "trace_get_tool_calls",
              arguments: { executionId },
              reason:
                "List the agent's tool calls with arguments and results for the branches seen in the tree.",
            },
          ],
        });
      } catch (error) {
        return errorResult("trace_get_tree", error);
      }
    },
  );

  register(
    "trace_get_tool_calls",
    "List the execution's agent tool calls (curated tool-span evidence): tool name, arguments, result, and status per call, paginated. Filter by sessionId, toolName, spanId, or errorsOnly. This answers 'what did the agent actually do' without per-span drills.",
    {
      title: "Get Agent Tool Calls",
      inputSchema: {
        executionId: z.string().min(6),
        spanId: z.string().optional(),
        sessionId: z.string().optional(),
        toolName: z.string().optional(),
        errorsOnly: z.boolean().optional(),
        limit: z.number().int().min(1).max(50).optional(),
        cursor: z.string().optional(),
      },
    },
    async (args: {
      executionId: string;
      spanId?: string;
      sessionId?: string;
      toolName?: string;
      errorsOnly?: boolean;
      limit?: number;
      cursor?: string;
    }) => {
      try {
        const data = await context.diagnostics.getToolCalls(
          args.executionId,
          args,
        );
        const first = firstRecord(data, "toolCalls");
        const nextActions: NextAction[] = [];
        if (typeof first?.spanId === "string" && first.status === "Error") {
          nextActions.push({
            tool: "trace_get_logs",
            arguments: { executionId: args.executionId, spanId: first.spanId },
            reason: "Correlate the first failing tool call with runtime logs.",
          });
        }
        const continuation = continuationAction(
          "trace_get_tool_calls",
          args,
          data,
          "Continue the tool-call page from the server-issued cursor.",
        );
        if (continuation) nextActions.push(continuation);
        return result(data, { tool: "trace_get_tool_calls", nextActions });
      } catch (error) {
        return errorResult("trace_get_tool_calls", error);
      }
    },
  );

  register(
    "trace_get_logs",
    "Search bounded execution-scoped logs, optionally by exact span, text, or error severity. Log bodies are redacted and size-capped by the diagnostics endpoint.",
    {
      title: "Get Correlated Logs",
      inputSchema: {
        executionId: z.string().min(6),
        spanId: z.string().optional(),
        query: z.string().optional(),
        errorsOnly: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().optional(),
      },
    },
    async (args: {
      executionId: string;
      spanId?: string;
      query?: string;
      errorsOnly?: boolean;
      limit?: number;
      cursor?: string;
    }) => {
      try {
        const data = await context.diagnostics.searchLogs(
          args.executionId,
          args,
        );
        const continuation = continuationAction(
          "trace_get_logs",
          args,
          data,
          "Continue the log search from the server-issued cursor.",
        );
        return result(data, {
          tool: "trace_get_logs",
          nextActions: continuation ? [continuation] : [],
        });
      } catch (error) {
        return errorResult("trace_get_logs", error);
      }
    },
  );

  register(
    "trace_get_browser_screenshot",
    "Return one execution-scoped browser screenshot as native MCP image content for vision analysis. Use a storageRef from debug_workflow_execution browserArtifacts; arbitrary or cross-execution refs return not found.",
    {
      title: "Get Browser Screenshot",
      inputSchema: {
        executionId: z.string().min(6),
        storageRef: z.string().min(1),
      },
    },
    async ({
      executionId,
      storageRef,
    }: {
      executionId: string;
      storageRef: string;
    }) => {
      try {
        const payload = record(
          await context.diagnostics.getBrowserScreenshot(
            executionId,
            storageRef,
          ),
        );
        if (
          !payload ||
          typeof payload.payloadBase64 !== "string" ||
          typeof payload.contentType !== "string" ||
          !payload.contentType.startsWith("image/")
        ) {
          throw Object.assign(
            new Error("Invalid browser screenshot response"),
            {
              status: 502,
              code: "invalid_screenshot_response",
            },
          );
        }
        const metadata = {
          storageRef:
            typeof payload.storageRef === "string"
              ? payload.storageRef
              : storageRef,
          contentType: payload.contentType,
          sizeBytes:
            typeof payload.sizeBytes === "number" ? payload.sizeBytes : null,
        };
        const base = result(metadata, { tool: "trace_get_browser_screenshot" });
        return {
          ...base,
          content: [
            ...base.content,
            {
              type: "image" as const,
              data: payload.payloadBase64,
              mimeType: payload.contentType,
            },
          ],
        };
      } catch (error) {
        return errorResult("trace_get_browser_screenshot", error);
      }
    },
  );

  return tools;
}

import type { WorkflowMcpPrincipal } from "../auth-context.js";
import type {
  TraceLlmTurnQuery,
  TraceLogQuery,
  TraceSpanQuery,
  WorkflowDiagnosticsPort,
  WorkflowExecutionListQuery,
} from "../ports/workflow-diagnostics.js";

const DEFAULT_WORKFLOW_BUILDER_URL =
  "http://workflow-builder.workflow-builder.svc.cluster.local:3000";

export class WorkflowDiagnosticsHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "WorkflowDiagnosticsHttpError";
  }
}

type HttpWorkflowDiagnosticsOptions = {
  principal: WorkflowMcpPrincipal;
  fetchImpl?: typeof fetch;
  workflowBuilderUrl?: string;
  internalApiToken?: string;
  timeoutMs?: number;
};

function setParam(
  params: URLSearchParams,
  name: string,
  value: string | number | boolean | undefined,
): void {
  if (value !== undefined && value !== "") params.set(name, String(value));
}

function responseError(
  status: number,
  body: unknown,
): WorkflowDiagnosticsHttpError {
  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const nested =
    record.error && typeof record.error === "object"
      ? (record.error as Record<string, unknown>)
      : null;
  const message =
    (typeof record.error === "string" && record.error) ||
    (typeof record.message === "string" && record.message) ||
    (typeof nested?.message === "string" && nested.message) ||
    `Workflow Builder diagnostics request failed (HTTP ${status})`;
  const code =
    (typeof record.code === "string" && record.code) ||
    (typeof nested?.code === "string" && nested.code) ||
    `http_${status}`;
  return new WorkflowDiagnosticsHttpError(message, status, code);
}

/** HTTP adapter for the Workflow Builder diagnostics application routes. */
export class HttpWorkflowDiagnosticsAdapter implements WorkflowDiagnosticsPort {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly internalApiToken: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpWorkflowDiagnosticsOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = (
      options.workflowBuilderUrl ??
      process.env.WORKFLOW_BUILDER_URL ??
      DEFAULT_WORKFLOW_BUILDER_URL
    ).replace(/\/$/, "");
    this.internalApiToken =
      options.internalApiToken ?? process.env.INTERNAL_API_TOKEN ?? "";
    this.timeoutMs =
      options.timeoutMs ?? (Number(process.env.TRACE_TOOL_TIMEOUT_MS) || 45_000);
  }

  listWorkflowExecutions(query: WorkflowExecutionListQuery): Promise<unknown> {
    const params = new URLSearchParams();
    setParam(params, "workflowId", query.workflowId);
    setParam(params, "workflowName", query.workflowName);
    setParam(params, "status", query.status);
    setParam(params, "limit", query.limit);
    setParam(params, "cursor", query.cursor);
    return this.get("/api/internal/observability/executions", params);
  }

  getExecutionOverview(executionId: string): Promise<unknown> {
    return this.get(`${this.executionPath(executionId)}/overview`);
  }

  getDigest(executionId: string): Promise<unknown> {
    return this.get(`${this.executionPath(executionId)}/digest`);
  }

  searchSpans(executionId: string, query: TraceSpanQuery): Promise<unknown> {
    const params = new URLSearchParams();
    setParam(params, "query", query.query);
    setParam(params, "errorsOnly", query.errorsOnly);
    setParam(params, "limit", query.limit);
    setParam(params, "cursor", query.cursor);
    return this.get(`${this.executionPath(executionId)}/spans`, params);
  }

  getSpan(executionId: string, spanId: string): Promise<unknown> {
    return this.get(
      `${this.executionPath(executionId)}/spans/${encodeURIComponent(spanId)}`,
    );
  }

  getLlmTurns(executionId: string, query: TraceLlmTurnQuery): Promise<unknown> {
    const params = new URLSearchParams();
    setParam(params, "spanId", query.spanId);
    setParam(params, "sessionId", query.sessionId);
    setParam(params, "limit", query.limit);
    setParam(params, "cursor", query.cursor);
    return this.get(`${this.executionPath(executionId)}/llm-turn`, params);
  }

  searchLogs(executionId: string, query: TraceLogQuery): Promise<unknown> {
    const params = new URLSearchParams();
    setParam(params, "spanId", query.spanId);
    setParam(params, "query", query.query);
    setParam(params, "errorsOnly", query.errorsOnly);
    setParam(params, "limit", query.limit);
    setParam(params, "cursor", query.cursor);
    return this.get(`${this.executionPath(executionId)}/logs`, params);
  }

  getBrowserScreenshot(executionId: string, storageRef: string): Promise<unknown> {
    const params = new URLSearchParams({ storageRef });
    return this.get(
      `${this.executionPath(executionId)}/browser-artifacts/screenshot`,
      params,
    );
  }

  private executionPath(executionId: string): string {
    return `/api/internal/observability/executions/${encodeURIComponent(executionId)}`;
  }

  private async get(path: string, params?: URLSearchParams): Promise<unknown> {
    if (!this.internalApiToken) {
      throw new WorkflowDiagnosticsHttpError(
        "INTERNAL_API_TOKEN is not configured",
        503,
        "diagnostics_not_configured",
      );
    }
    const query = params?.toString();
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}${path}${query ? `?${query}` : ""}`,
        {
          headers: {
            Accept: "application/json",
            "X-Internal-Token": this.internalApiToken,
            "X-Wfb-Principal-Assertion": this.options.principal.principalAssertion,
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch (error) {
      const timedOut =
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError");
      throw new WorkflowDiagnosticsHttpError(
        timedOut
          ? `Workflow diagnostics timed out after ${this.timeoutMs}ms`
          : `Workflow diagnostics are unavailable: ${error instanceof Error ? error.message : String(error)}`,
        timedOut ? 504 : 503,
        timedOut ? "diagnostics_timeout" : "diagnostics_unavailable",
      );
    }

    const body = await response.json().catch(() => null);
    if (!response.ok) throw responseError(response.status, body);
    return body;
  }
}

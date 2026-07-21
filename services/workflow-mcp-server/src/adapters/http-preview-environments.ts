import type { WorkflowMcpPrincipal } from "../auth-context.js";
import {
  PreviewEnvironmentRequestError,
  type PreviewEnvironmentLaunchInput,
  type PreviewEnvironmentsPort,
  type PreviewTeardownInput,
  type PreviewTeardownTicket,
  type PreviewTraceQuery,
} from "../ports/preview-environments.js";

const DEFAULT_WORKFLOW_BUILDER_URL =
  "http://workflow-builder.workflow-builder.svc.cluster.local:3000";
export const DEFAULT_PREVIEW_ENVIRONMENT_REQUEST_TIMEOUT_MS = 25_000;

export class PreviewEnvironmentsHttpError extends PreviewEnvironmentRequestError {
  constructor(
    message: string,
    readonly status: number,
    code: string,
    retryable: boolean,
    retryAfterMs?: number,
    details?: unknown,
  ) {
    super(message, code, retryable, retryAfterMs, details);
    this.name = "PreviewEnvironmentsHttpError";
  }
}

type HttpPreviewEnvironmentOptions = {
  principal: WorkflowMcpPrincipal;
  fetchImpl?: typeof fetch;
  workflowBuilderUrl?: string;
  internalApiToken?: string;
  timeoutMs?: number;
};

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function responseError(
  status: number,
  body: unknown,
  retryAfter: string | null,
): PreviewEnvironmentsHttpError {
  const root = object(body);
  const error = object(root?.error);
  const message =
    (typeof error?.message === "string" && error.message) ||
    (typeof root?.error === "string" && root.error) ||
    (typeof root?.message === "string" && root.message) ||
    `Preview environment request failed (HTTP ${status})`;
  const code =
    (typeof error?.code === "string" && error.code) ||
    (typeof root?.code === "string" && root.code) ||
    `preview_http_${status}`;
  const retryAfterSeconds = retryAfter == null ? NaN : Number(retryAfter);
  const details =
    error?.details !== undefined
      ? error.details
      : root?.teardown === undefined
        ? undefined
        : { teardown: root.teardown, ticket: root.ticket };
  return new PreviewEnvironmentsHttpError(
    message,
    status,
    code,
    status === 408 || status === 429 || status >= 500,
    Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds * 1000
      : undefined,
    details,
  );
}

function setParam(
  params: URLSearchParams,
  name: string,
  value: string | number | undefined,
): void {
  if (value !== undefined && value !== "") params.set(name, String(value));
}

function isTimeout(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    (cause.name === "TimeoutError" || cause.name === "AbortError")
  );
}

function requestTransportError(
  cause: unknown,
  timeoutMs: number,
  phase: "request" | "response",
): PreviewEnvironmentsHttpError {
  if (isTimeout(cause)) {
    return new PreviewEnvironmentsHttpError(
      `Preview environment request timed out after ${timeoutMs}ms`,
      504,
      "preview_management_timeout",
      true,
    );
  }
  return new PreviewEnvironmentsHttpError(
    phase === "response"
      ? "Preview environment service returned an unreadable response"
      : "Preview environment service is unavailable",
    phase === "response" ? 502 : 503,
    phase === "response"
      ? "preview_management_invalid_response"
      : "preview_management_unavailable",
    true,
  );
}

/** HTTP adapter for the BFF-owned preview management and diagnostics boundary. */
export class HttpPreviewEnvironmentsAdapter implements PreviewEnvironmentsPort {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly internalApiToken: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpPreviewEnvironmentOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = (
      options.workflowBuilderUrl ??
      process.env.WORKFLOW_BUILDER_URL ??
      DEFAULT_WORKFLOW_BUILDER_URL
    ).replace(/\/$/, "");
    this.internalApiToken =
      options.internalApiToken ?? process.env.INTERNAL_API_TOKEN ?? "";
    this.timeoutMs =
      options.timeoutMs ?? DEFAULT_PREVIEW_ENVIRONMENT_REQUEST_TIMEOUT_MS;
  }

  list(): ReturnType<PreviewEnvironmentsPort["list"]> {
    return this.request("/api/internal/preview-environments");
  }

  listServices(): ReturnType<PreviewEnvironmentsPort["listServices"]> {
    return this.request("/api/internal/preview-environments/services");
  }

  get(name: string): ReturnType<PreviewEnvironmentsPort["get"]> {
    return this.request(this.previewPath(name));
  }

  launch(
    input: PreviewEnvironmentLaunchInput,
  ): ReturnType<PreviewEnvironmentsPort["launch"]> {
    return this.request("/api/internal/preview-environments", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  getRuntime(
    name: string,
  ): ReturnType<PreviewEnvironmentsPort["getRuntime"]> {
    return this.request(`${this.previewPath(name)}/runtime`);
  }

  queryTraces(
    name: string,
    query: PreviewTraceQuery,
  ): ReturnType<PreviewEnvironmentsPort["queryTraces"]> {
    const params = new URLSearchParams();
    setParam(params, "range", query.range);
    setParam(params, "status", query.status);
    setParam(params, "service", query.service);
    setParam(params, "search", query.search);
    setParam(params, "limit", query.limit);
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.request(`${this.previewPath(name)}/traces${suffix}`);
  }

  teardown(
    name: string,
    input: PreviewTeardownInput,
  ): ReturnType<PreviewEnvironmentsPort["teardown"]> {
    return this.request(this.previewPath(name), {
      method: "DELETE",
      body: JSON.stringify(input),
    });
  }

  getTeardownStatus(
    ticket: PreviewTeardownTicket,
  ): ReturnType<PreviewEnvironmentsPort["getTeardownStatus"]> {
    return this.request(`${this.previewPath(ticket.name)}/teardown/status`, {
      method: "POST",
      body: JSON.stringify(ticket),
    });
  }

  private previewPath(name: string): string {
    return `/api/internal/preview-environments/${encodeURIComponent(name)}`;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.internalApiToken) {
      throw new PreviewEnvironmentsHttpError(
        "INTERNAL_API_TOKEN is not configured",
        503,
        "preview_management_not_configured",
        true,
      );
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Internal-Token": this.internalApiToken,
          "X-Wfb-Principal-Assertion":
            this.options.principal.principalAssertion,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw requestTransportError(cause, this.timeoutMs, "request");
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      throw requestTransportError(cause, this.timeoutMs, "response");
    }
    if (!response.ok) {
      throw responseError(
        response.status,
        body,
        response.headers?.get("retry-after") ?? null,
      );
    }
    if (!object(body)) {
      throw requestTransportError(
        new TypeError("invalid response body"),
        this.timeoutMs,
        "response",
      );
    }
    return body as T;
  }
}

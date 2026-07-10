import { env } from "$env/dynamic/private";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { setSpanValue } from "$lib/server/observability/content";

/** Get the Dapr sidecar base URL (localhost) */
export function getDaprSidecarUrl(): string {
  const port = env.DAPR_HTTP_PORT || "3500";
  return `http://localhost:${port}`;
}

const RETRYABLE_STATUS_CODES = new Set([408, 429, 502, 503, 504]);
const SAFE_METHODS = new Set(["GET", "HEAD"]);
const DEFAULT_MAX_RETRIES = 3;

interface DaprRequestOptions extends RequestInit {
  maxRetries?: number;
  spanInput?: unknown;
  captureResponseBodyForSpan?: boolean;
}

type DaprFetchTarget = {
  operation: string;
  service?: string;
  component?: string;
  path: string;
  url: string;
};

const tracer = trace.getTracer("workflow-builder.dapr-client");

function describeDaprFetch(url: string): DaprFetchTarget {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);

    if (parts[0] === "v1.0" && parts[1] === "state") {
      return {
        operation: parts.length > 3 ? "dapr.state.get" : "dapr.state.bulk",
        component: parts[2],
        path: parts.length > 3 ? "/v1.0/state/:store/:key" : "/v1.0/state/:store",
        url,
      };
    }

    if (parts[0] === "v1.0" && parts[1] === "invoke") {
      return {
        operation: "dapr.service.invoke",
        service: parts[2],
        path: `/v1.0/invoke/${parts[2] ?? ":app"}/method/${parts.slice(4).join("/") || ":method"}`,
        url,
      };
    }

    if (parts[0] === "v1.0" && parts[1] === "bindings") {
      return {
        operation: "dapr.binding.invoke",
        component: parts[2],
        path: "/v1.0/bindings/:name",
        url,
      };
    }

    if (parts[0] === "v1.0" && parts[1] === "configuration") {
      return {
        operation: "dapr.configuration.get",
        component: parts[2],
        path: "/v1.0/configuration/:store",
        url,
      };
    }

    if (parts[0] === "v1.0" && parts[1] === "secrets") {
      return {
        operation: "dapr.secret.get",
        component: parts[2],
        path: "/v1.0/secrets/:store/:key",
        url,
      };
    }

    if (parts[0] === "v1.0" && parts[1] === "workflows") {
      return {
        operation: "dapr.workflow",
        component: parts[2],
        path: "/v1.0/workflows/:component/:instance",
        url,
      };
    }

    return {
      operation: "http.fetch",
      service: parsed.hostname,
      path: parsed.pathname || "/",
      url,
    };
  } catch {
    return {
      operation: "http.fetch",
      path: url,
      url,
    };
  }
}

function requestBodyForSpan(body: BodyInit | null | undefined): unknown {
  if (body == null) return undefined;
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (!trimmed) return "";
    try {
      return JSON.parse(trimmed);
    } catch {
      return body;
    }
  }
  if (body instanceof URLSearchParams) return Object.fromEntries(body);
  if (body instanceof ArrayBuffer) return `[ArrayBuffer ${body.byteLength} bytes]`;
  if (ArrayBuffer.isView(body)) {
    return `[${body.constructor.name} ${body.byteLength} bytes]`;
  }
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    return Object.fromEntries(body.entries());
  }
  return `[${body.constructor.name || "Body"}]`;
}

export async function responseBodyForSpan(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("event-stream")) {
    return {
      status: response.status,
      contentType,
      body: "[streaming response omitted]",
    };
  }
  if (
    !contentType.includes("json") &&
    !contentType.startsWith("text/")
  ) {
    return {
      status: response.status,
      contentType,
      body: contentType ? "[non-text response]" : "",
    };
  }

  const text = await response.clone().text();
  if (!text.trim()) {
    return { status: response.status, body: "" };
  }
  if (contentType.includes("json")) {
    try {
      return { status: response.status, body: JSON.parse(text) };
    } catch {
      return { status: response.status, body: text };
    }
  }
  return { status: response.status, body: text };
}

/**
 * Make a request to a Dapr service with retry logic.
 * Mirrors the retry behavior from the Next.js workflow-builder dapr-client.ts.
 */
export async function daprFetch(
  url: string,
  options: DaprRequestOptions = {},
): Promise<Response> {
  const {
    maxRetries = DEFAULT_MAX_RETRIES,
    spanInput,
    captureResponseBodyForSpan = true,
    ...fetchOptions
  } = options;
  const method = (fetchOptions.method || "GET").toUpperCase();
  const target = describeDaprFetch(url);

  return tracer.startActiveSpan(
    `workflow-builder.daprFetch ${method} ${target.operation}`,
    async (span) => {
      span.setAttribute("http.request.method", method);
      span.setAttribute("url.full", target.url);
      span.setAttribute("url.path", target.path);
      span.setAttribute("dapr.operation", target.operation);
      if (target.service) span.setAttribute("dapr.target_service", target.service);
      if (target.component) span.setAttribute("dapr.component", target.component);
      setSpanValue(
        span,
        "input",
        spanInput ?? {
          method,
          target,
          body: requestBodyForSpan(fetchOptions.body),
        },
      );

      let lastError: Error | undefined;

      try {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          span.setAttribute("dapr.fetch.attempt", attempt + 1);
          try {
            const response = await fetch(url, fetchOptions);

            if (
              RETRYABLE_STATUS_CODES.has(response.status) &&
              SAFE_METHODS.has(method) &&
              attempt < maxRetries
            ) {
              await new Promise((r) => setTimeout(r, attempt * 250));
              continue;
            }

            span.setAttribute("http.response.status_code", response.status);
            if (captureResponseBodyForSpan) {
              try {
                setSpanValue(span, "output", await responseBodyForSpan(response));
              } catch {
                setSpanValue(span, "output", {
                  status: response.status,
                  body: "[response capture failed]",
                });
              }
            } else {
              setSpanValue(span, "output", {
                status: response.status,
                body: "[response body capture disabled]",
              });
            }
            if (!response.ok) {
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: `HTTP ${response.status}`,
              });
            }
            return response;
          } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            if (attempt < maxRetries && SAFE_METHODS.has(method)) {
              await new Promise((r) => setTimeout(r, attempt * 250));
              continue;
            }
          }
        }

        throw lastError || new Error("daprFetch failed after retries");
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        setSpanValue(span, "output", {
          ok: false,
          error: err.message,
          method,
          target,
          attempts: maxRetries + 1,
        });
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/** Get the workflow orchestrator base URL */
export function getOrchestratorUrl(): string {
  return (
    env.WORKFLOW_ORCHESTRATOR_URL ||
    env.DAPR_ORCHESTRATOR_URL ||
    "http://workflow-orchestrator.workflow-builder.svc.cluster.local:8080"
  );
}

/** Get the dapr-agent-py base URL */
export function getDaprAgentPyUrl(runtime: string | null | undefined = "dapr-agent-py"): string {
  return getDaprAgentPyUrls(runtime)[0];
}

/** Get candidate dapr-agent-py base URLs in lookup order. */
export function getDaprAgentPyUrls(runtime: string | null | undefined = "dapr-agent-py"): string[] {
  const normalized = runtime || "dapr-agent-py";
  if (normalized === "dapr-agent-py-testing") {
    return uniqueUrls([
      env.DAPR_AGENT_PY_TESTING_URL,
      "http://dapr-agent-py-testing.workflow-builder.svc.cluster.local:8002",
      "http://dapr-agent-py-testing.openshell.svc.cluster.local:8002"
    ]);
  }
  return uniqueUrls([
    env.DAPR_AGENT_PY_URL,
    "http://dapr-agent-py.workflow-builder.svc.cluster.local:8002",
    "http://dapr-agent-py.openshell.svc.cluster.local:8002"
  ]);
}

function uniqueUrls(urls: Array<string | null | undefined>): string[] {
  return [...new Set(urls.filter((url): url is string => Boolean(url?.trim())))];
}

/** Get the function router base URL */
export function getFunctionRouterUrl(): string {
  const raw =
    env.FUNCTION_RUNNER_URL ||
    "http://function-router.workflow-builder.svc.cluster.local";

  // The in-cluster function-router Service is exposed on port 80 and proxies to container port 8080.
  // DevSpace/stacks have historically injected :8080 here, which bypasses the Service port and times out.
  if (
    raw === "http://function-router.workflow-builder.svc.cluster.local:8080"
  ) {
    return "http://function-router.workflow-builder.svc.cluster.local";
  }

  return raw;
}

/** Get the workspace runtime base URL */
export function getWorkspaceRuntimeUrl(): string {
	if (
		(
			env.PREVIEW_HOST_RUNTIMES_DISABLED ??
			process.env.PREVIEW_HOST_RUNTIMES_DISABLED ??
			""
		).trim().toLowerCase() === "true" &&
		!(env.WORKSPACE_RUNTIME_URL ?? process.env.WORKSPACE_RUNTIME_URL)
	) {
		throw new Error("workspace-runtime is unavailable inside PreviewEnvironment");
	}
  return (
    env.WORKSPACE_RUNTIME_URL ||
    "http://workspace-runtime.workflow-builder.svc.cluster.local:8001"
  );
}

/** Get the code runtime base URL */
export function getCodeRuntimeUrl(): string {
  return (
    env.CODE_RUNTIME_URL ||
    "http://code-runtime.workflow-builder.svc.cluster.local:8080"
  );
}

/** Get the fn-system base URL */
export function getFnSystemUrl(): string {
  const url =
    env.FN_SYSTEM_URL ||
    "http://fn-system.workflow-builder.svc.cluster.local";
  if (url.startsWith("http://") && !url.match(/:\d+$/)) {
    return url;
  }
  return url;
}

// ---------------------------------------------------------------------------
// Workflow-capable service discovery
// ---------------------------------------------------------------------------

export interface WorkflowServiceDescriptor {
  id: string;
  getBaseUrl: () => string;
  introspectPath: string;
}

/**
 * Static registry of services that register Dapr workflow activities.
 * Add new entries here when a new workflow-capable service is deployed.
 */
export function getWorkflowCapableServices(): WorkflowServiceDescriptor[] {
  return [
    {
      id: "workflow-orchestrator",
      getBaseUrl: getOrchestratorUrl,
      introspectPath: "/api/v2/runtime/introspect",
    },
    {
      id: "workspace-runtime",
      getBaseUrl: getWorkspaceRuntimeUrl,
      introspectPath: "/api/runtime/introspect",
    },
    {
      id: "fn-system",
      getBaseUrl: getFnSystemUrl,
      introspectPath: "/api/runtime/introspect",
    },
    {
      id: "code-runtime",
      getBaseUrl: getCodeRuntimeUrl,
      introspectPath: "/api/runtime/introspect",
    },
  ];
}

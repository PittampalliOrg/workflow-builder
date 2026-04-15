import { env } from "$env/dynamic/private";

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
}

/**
 * Make a request to a Dapr service with retry logic.
 * Mirrors the retry behavior from the Next.js workflow-builder dapr-client.ts.
 */
export async function daprFetch(
  url: string,
  options: DaprRequestOptions = {},
): Promise<Response> {
  const { maxRetries = DEFAULT_MAX_RETRIES, ...fetchOptions } = options;
  const method = (fetchOptions.method || "GET").toUpperCase();

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
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
  const normalized = runtime || "dapr-agent-py";
  if (normalized === "dapr-agent-py-testing") {
    return (
      env.DAPR_AGENT_PY_TESTING_URL ||
      "http://dapr-agent-py-testing.workflow-builder.svc.cluster.local:8002"
    );
  }
  return (
    env.DAPR_AGENT_PY_URL ||
    "http://dapr-agent-py.workflow-builder.svc.cluster.local:8002"
  );
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

/** Get the durable agent base URL */
export function getDurableAgentUrl(): string {
  return (
    env.DURABLE_AGENT_URL ||
    "http://durable-agent.workflow-builder.svc.cluster.local:8001"
  );
}

/** Get the workspace runtime base URL */
export function getWorkspaceRuntimeUrl(): string {
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

/** Get the fn-activepieces base URL */
export function getFnActivepiecesUrl(): string {
  const url =
    env.FN_ACTIVEPIECES_URL ||
    "http://fn-activepieces.workflow-builder.svc.cluster.local:8080";
  // Ensure port is present (env var from K8s service discovery may omit it)
  if (url.startsWith("http://") && !url.match(/:\d+$/)) {
    return `${url}:8080`;
  }
  return url;
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
      id: "durable-agent",
      getBaseUrl: getDurableAgentUrl,
      introspectPath: "/api/runtime/introspect",
    },
    {
      id: "workspace-runtime",
      getBaseUrl: getWorkspaceRuntimeUrl,
      introspectPath: "/api/runtime/introspect",
    },
    {
      id: "fn-activepieces",
      getBaseUrl: getFnActivepiecesUrl,
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

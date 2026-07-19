import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export const WORKFLOW_MCP_SCOPES = [
  "workflow:read",
  "workflow:write",
  "workflow:execute",
  "agent:write",
  "session:goal",
  "session:team",
  // Legacy platform claim retained for mixed-version rollouts. Trace tools
  // authorize with workflow:read and do not depend on this scope.
  "session:trace",
] as const;

export type WorkflowMcpScope = (typeof WORKFLOW_MCP_SCOPES)[number];
export type WorkflowMcpAuthMode = "workspace_api_key" | "platform_session";

export type WorkflowMcpPrincipal = {
  authMode: WorkflowMcpAuthMode;
  userId: string;
  projectId: string;
  workspace?: { id: string; slug?: string; name?: string };
  scopes: string[];
  apiKeyId?: string;
  sessionId?: string;
  principalAssertion: string;
  capabilities: {
    scriptDepth: number;
    teamId: string | null;
    teamRole: "none" | "lead" | "member";
  };
};

export type WorkflowMcpAuthError = {
  code:
    | "workspace_auth_required"
    | "workspace_key_required"
    | "invalid_credentials"
    | "session_context_invalid"
    | "auth_service_unavailable";
  message: string;
};

export type WorkflowMcpRequestContext = {
  principal: WorkflowMcpPrincipal | null;
  error?: WorkflowMcpAuthError;
};

type ResolvePrincipalResponse = {
  authenticated?: boolean;
  authMode?: WorkflowMcpAuthMode;
  userId?: string;
  projectId?: string | null;
  workspace?: { id?: string; slug?: string; name?: string };
  scopes?: unknown;
  apiKeyId?: string;
  principalAssertion?: string;
  capabilities?: {
    scriptDepth?: unknown;
    teamId?: unknown;
    teamRole?: unknown;
  };
  error?: string;
  code?: string;
};

type ResolveOptions = {
  fetchImpl?: typeof fetch;
  workflowBuilderUrl?: string;
  internalApiToken?: string;
};

const contextStorage = new AsyncLocalStorage<WorkflowMcpRequestContext>();

const DEFAULT_WORKFLOW_BUILDER_URL =
  "http://workflow-builder.workflow-builder.svc.cluster.local:3000";
const REFRESHED_TOKEN_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const refreshedSessionTokens = new Map<
  string,
  { token: string; expiresAt: number }
>();

function sessionTokenCacheKey(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function cachedSessionToken(token: string): string {
  const key = sessionTokenCacheKey(token);
  const cached = refreshedSessionTokens.get(key);
  if (!cached) return token;
  if (cached.expiresAt <= Date.now()) {
    refreshedSessionTokens.delete(key);
    return token;
  }
  return cached.token;
}

async function refreshSessionToken(input: {
  fetchImpl: typeof fetch;
  workflowBuilderUrl: string;
  internalApiToken: string;
  sessionId: string;
  staleToken: string;
  originalToken: string;
}): Promise<string | null> {
  const response = await input.fetchImpl(
    `${input.workflowBuilderUrl.replace(/\/$/, "")}/api/internal/auth/workflow-mcp-session/refresh`,
    {
      method: "POST",
      headers: {
        "X-Internal-Token": input.internalApiToken,
        "X-Wfb-Session-Id": input.sessionId,
        "X-Wfb-Session-Token": input.staleToken,
      },
    },
  );
  const body = (await response.json().catch(() => null)) as {
    workflowMcpSessionToken?: unknown;
  } | null;
  const refreshed =
    response.ok && typeof body?.workflowMcpSessionToken === "string"
      ? body.workflowMcpSessionToken.trim()
      : "";
  if (!refreshed) return null;
  const entry = {
    token: refreshed,
    expiresAt: Date.now() + REFRESHED_TOKEN_CACHE_TTL_MS,
  };
  refreshedSessionTokens.set(sessionTokenCacheKey(input.originalToken), entry);
  refreshedSessionTokens.set(sessionTokenCacheKey(input.staleToken), entry);
  return refreshed;
}

function firstHeader(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function authError(
  code: WorkflowMcpAuthError["code"],
  message: string,
): WorkflowMcpRequestContext {
  return { principal: null, error: { code, message } };
}

function normalizedScopes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter((scope): scope is string => typeof scope === "string"),
    ),
  ];
}

const SESSION_CONTEXT_ERROR_CODES = new Set([
  "session_not_found",
  "session_inactive",
  "session_principal_mismatch",
  "session_token_mismatch",
  "platform_session_principal_mismatch",
  "platform_session_inactive",
]);

function resolverError(
  status: number,
  body: ResolvePrincipalResponse | null,
): WorkflowMcpRequestContext {
  if (body?.code && SESSION_CONTEXT_ERROR_CODES.has(body.code)) {
    return authError(
      "session_context_invalid",
      `${body.error ?? "The Workflow Builder session context is invalid."} Fix or unset WFB_MCP_SESSION_ID, then reconnect.`,
    );
  }
  if (status === 403 && body?.code === "workspace_key_required") {
    return authError(
      "workspace_key_required",
      body.error ??
        "This is a legacy user API key. Create a workspace-scoped API key in Workflow Builder settings.",
    );
  }
  if (status === 401 || status === 403) {
    return authError(
      "invalid_credentials",
      body?.error ??
        "The Workflow Builder credential is invalid or no longer authorized.",
    );
  }
  return authError(
    "auth_service_unavailable",
    body?.error ?? `Workflow Builder authentication failed (HTTP ${status}).`,
  );
}

/**
 * Resolve the connection principal through the Workflow Builder application
 * boundary. The BFF owns API-key hashing, workspace membership checks, key
 * last-used updates, and signed platform-session-token validation.
 */
export async function resolveWorkflowMcpContext(
  headers: IncomingHttpHeaders,
  opts: ResolveOptions = {},
): Promise<WorkflowMcpRequestContext> {
  const authorization = firstHeader(headers, "authorization");
  const sessionToken = firstHeader(headers, "x-wfb-session-token");
  const sessionId = firstHeader(headers, "x-wfb-session-id");

  if (!authorization && !sessionToken) {
    return authError(
      "workspace_auth_required",
      "Authenticate with Authorization: Bearer <workspace API key>. Platform agents receive a signed session credential automatically; a session ID alone is not authentication.",
    );
  }
  if (sessionToken && !sessionId) {
    return authError(
      "session_context_invalid",
      "X-Wfb-Session-Token requires its matching X-Wfb-Session-Id.",
    );
  }

  const internalApiToken =
    opts.internalApiToken ?? process.env.INTERNAL_API_TOKEN ?? "";
  if (!internalApiToken) {
    return authError(
      "auth_service_unavailable",
      "Workflow MCP authentication is not configured.",
    );
  }

  const requestHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Internal-Token": internalApiToken,
  };
  if (authorization) requestHeaders.Authorization = authorization;
  if (sessionToken) {
    requestHeaders["X-Wfb-Session-Token"] = cachedSessionToken(sessionToken);
  }
  if (sessionId) requestHeaders["X-Wfb-Session-Id"] = sessionId;

  const fetchImpl = opts.fetchImpl ?? fetch;
  const workflowBuilderUrl =
    opts.workflowBuilderUrl ??
    process.env.WORKFLOW_BUILDER_URL ??
    DEFAULT_WORKFLOW_BUILDER_URL;

  let response: Response;
  try {
    response = await fetchImpl(
      `${workflowBuilderUrl.replace(/\/$/, "")}/api/internal/auth/workflow-mcp-principal`,
      { method: "POST", headers: requestHeaders },
    );
  } catch (error) {
    return authError(
      "auth_service_unavailable",
      `Workflow Builder authentication is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let body = (await response
    .json()
    .catch(() => null)) as ResolvePrincipalResponse | null;
  if (
    !response.ok &&
    response.status === 401 &&
    body?.code === "invalid_platform_session_token" &&
    sessionToken &&
    sessionId
  ) {
    try {
      const refreshed = await refreshSessionToken({
        fetchImpl,
        workflowBuilderUrl,
        internalApiToken,
        sessionId,
        staleToken: requestHeaders["X-Wfb-Session-Token"] ?? sessionToken,
        originalToken: sessionToken,
      });
      if (refreshed) {
        requestHeaders["X-Wfb-Session-Token"] = refreshed;
        response = await fetchImpl(
          `${workflowBuilderUrl.replace(/\/$/, "")}/api/internal/auth/workflow-mcp-principal`,
          { method: "POST", headers: requestHeaders },
        );
        body = (await response
          .json()
          .catch(() => null)) as ResolvePrincipalResponse | null;
      }
    } catch {
      // Preserve the authoritative resolver failure below.
    }
  }
  if (!response.ok || body?.authenticated !== true) {
    return resolverError(response.status, body);
  }
  if (!body.userId || !body.projectId) {
    return authError(
      "workspace_key_required",
      "The credential is not bound to a workspace. Create a workspace-scoped API key in Workflow Builder settings.",
    );
  }
  if (!body.principalAssertion) {
    return authError(
      "auth_service_unavailable",
      "Workflow Builder did not issue a signed principal assertion.",
    );
  }
  const scriptDepth = body.capabilities?.scriptDepth;
  const teamId = body.capabilities?.teamId;
  const teamRole = body.capabilities?.teamRole;
  if (
    !Number.isInteger(scriptDepth) ||
    Number(scriptDepth) < 0 ||
    (teamId !== null && typeof teamId !== "string") ||
    !(["none", "lead", "member"] as const).includes(
      teamRole as "none" | "lead" | "member",
    )
  ) {
    return authError(
      "auth_service_unavailable",
      "Workflow Builder returned invalid Workflow MCP capabilities.",
    );
  }

  const authMode: WorkflowMcpAuthMode =
    body.authMode ?? (sessionToken ? "platform_session" : "workspace_api_key");
  const principal: WorkflowMcpPrincipal = {
    authMode,
    userId: body.userId,
    projectId: body.projectId,
    ...(body.workspace?.id
      ? {
          workspace: {
            id: body.workspace.id,
            ...(body.workspace.slug ? { slug: body.workspace.slug } : {}),
            ...(body.workspace.name ? { name: body.workspace.name } : {}),
          },
        }
      : {}),
    scopes: normalizedScopes(body.scopes),
    principalAssertion: body.principalAssertion,
    capabilities: {
      scriptDepth: Number(scriptDepth),
      teamId: teamId as string | null,
      teamRole: teamRole as "none" | "lead" | "member",
    },
    ...(body.apiKeyId ? { apiKeyId: body.apiKeyId } : {}),
    ...(sessionId ? { sessionId } : {}),
  };

  return { principal };
}

export function hasWorkflowMcpScope(
  principal: WorkflowMcpPrincipal | null | undefined,
  scope: WorkflowMcpScope,
): boolean {
  return principal?.scopes.includes(scope) === true;
}

export function workflowMcpSessionToolAccess(
  principal: WorkflowMcpPrincipal | null | undefined,
): { goal: boolean; team: boolean } {
  const hasSession = Boolean(principal?.sessionId);
  return {
    goal: hasSession && hasWorkflowMcpScope(principal, "session:goal"),
    team: hasSession && hasWorkflowMcpScope(principal, "session:team"),
  };
}

export function runWithWorkflowMcpContext<T>(
  context: WorkflowMcpRequestContext,
  fn: () => T,
): T {
  return contextStorage.run(context, fn);
}

export function currentWorkflowMcpContext(): WorkflowMcpRequestContext {
  return (
    contextStorage.getStore() ?? {
      principal: null,
      error: {
        code: "workspace_auth_required",
        message: "No Workflow MCP request context is active.",
      },
    }
  );
}

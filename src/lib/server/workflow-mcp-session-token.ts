import { createHmac, timingSafeEqual } from "node:crypto";
import type { WorkflowMcpSessionIdentity } from "$lib/server/application/ports/workflow-mcp-auth";

export type {
  WorkflowMcpSessionCapabilities,
  WorkflowMcpSessionIdentity,
} from "$lib/server/application/ports/workflow-mcp-auth";

const TOKEN_PREFIX = "wfb_session_v3";
const TOKEN_AUDIENCE = "workflow-mcp-server";
const DEFAULT_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_REFRESH_GRACE_SECONDS = 30 * 24 * 60 * 60;

type WorkflowMcpSessionTokenPayload = WorkflowMcpSessionIdentity & {
  v: 1;
  aud: string;
  iat: number;
  exp: number;
};

function deploymentAudience(): string {
  const environment =
    process.env.WORKFLOW_MCP_SESSION_TOKEN_AUDIENCE?.trim() ||
    process.env.APP_PUBLIC_URL?.trim() ||
    process.env.ORIGIN?.trim() ||
    (process.env.NODE_ENV === "production" ? "production" : "local");
  return `${TOKEN_AUDIENCE}:${environment}`;
}

function tokenTtlSeconds(): number {
  const configured = Number.parseInt(
    process.env.WORKFLOW_MCP_SESSION_TOKEN_TTL_SECONDS ?? "",
    10,
  );
  return Number.isSafeInteger(configured) && configured >= 60
    ? configured
    : DEFAULT_TOKEN_TTL_SECONDS;
}

function refreshGraceSeconds(): number {
  const configured = Number.parseInt(
    process.env.WORKFLOW_MCP_SESSION_TOKEN_REFRESH_GRACE_SECONDS ?? "",
    10,
  );
  return Number.isSafeInteger(configured) && configured >= 60
    ? configured
    : DEFAULT_REFRESH_GRACE_SECONDS;
}

function signingSecret(): string {
  const secret =
    process.env.WORKFLOW_MCP_SIGNING_SECRET?.trim() ||
    process.env.JWT_SIGNING_KEY?.trim();
  if (!secret) {
    throw new Error(
      "WORKFLOW_MCP_SIGNING_SECRET or JWT_SIGNING_KEY is required for Workflow MCP session tokens",
    );
  }
  return secret;
}

function signature(payload: string): Buffer {
  return createHmac("sha256", signingSecret())
    .update(`${TOKEN_PREFIX}.${payload}`)
    .digest();
}

export function mintWorkflowMcpSessionToken(
  identity: WorkflowMcpSessionIdentity,
  now = new Date(),
): string {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const payload: WorkflowMcpSessionTokenPayload = {
    v: 1,
    aud: deploymentAudience(),
    userId: identity.userId,
    projectId: identity.projectId,
    sessionId: identity.sessionId,
    capabilities: identity.capabilities,
    iat: issuedAt,
    exp: issuedAt + tokenTtlSeconds(),
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return `${TOKEN_PREFIX}.${encoded}.${signature(encoded).toString("base64url")}`;
}

function verifySessionToken(
  token: string,
  now = new Date(),
  allowedExpiredSeconds = 0,
): WorkflowMcpSessionIdentity | null {
  try {
    const [prefix, encoded, encodedSignature, extra] = token.split(".");
    if (
      prefix !== TOKEN_PREFIX ||
      !encoded ||
      !encodedSignature ||
      extra !== undefined
    ) {
      return null;
    }
    const receivedSignature = Buffer.from(encodedSignature, "base64url");
    const expectedSignature = signature(encoded);
    if (
      receivedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(receivedSignature, expectedSignature)
    ) {
      return null;
    }
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<WorkflowMcpSessionTokenPayload>;
    const nowSeconds = Math.floor(now.getTime() / 1000);
    if (
      payload.v !== 1 ||
      payload.aud !== deploymentAudience() ||
      typeof payload.userId !== "string" ||
      !payload.userId ||
      typeof payload.projectId !== "string" ||
      !payload.projectId ||
      typeof payload.sessionId !== "string" ||
      !payload.sessionId ||
      !payload.capabilities ||
      typeof payload.capabilities !== "object" ||
      !Number.isInteger(payload.capabilities.scriptDepth) ||
      payload.capabilities.scriptDepth < 0 ||
      (payload.capabilities.teamId !== null &&
        typeof payload.capabilities.teamId !== "string") ||
      !(["none", "lead", "member"] as const).includes(
        payload.capabilities.teamRole as "none" | "lead" | "member",
      ) ||
      (payload.capabilities.teamRole === "none" &&
        payload.capabilities.teamId !== null) ||
      (payload.capabilities.teamRole !== "none" &&
        !payload.capabilities.teamId) ||
      typeof payload.iat !== "number" ||
      payload.iat > nowSeconds + 60 ||
      typeof payload.exp !== "number" ||
      !Number.isInteger(payload.exp) ||
      payload.exp <= nowSeconds - allowedExpiredSeconds ||
      payload.exp <= payload.iat
    ) {
      return null;
    }
    return {
      userId: payload.userId,
      projectId: payload.projectId,
      sessionId: payload.sessionId,
      capabilities: {
        scriptDepth: payload.capabilities.scriptDepth,
        teamId: payload.capabilities.teamId,
        teamRole: payload.capabilities.teamRole,
      },
    };
  } catch {
    return null;
  }
}

export function verifyWorkflowMcpSessionToken(
  token: string,
  now = new Date(),
): WorkflowMcpSessionIdentity | null {
  return verifySessionToken(token, now);
}

export function verifyWorkflowMcpSessionTokenForRefresh(
  token: string,
  now = new Date(),
): WorkflowMcpSessionIdentity | null {
  return verifySessionToken(token, now, refreshGraceSeconds());
}

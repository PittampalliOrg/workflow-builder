import { createHmac, timingSafeEqual } from "node:crypto";
import type { WorkflowMcpPrincipalAssertion } from "$lib/server/application/ports/workflow-mcp-auth";

export type { WorkflowMcpPrincipalAssertion } from "$lib/server/application/ports/workflow-mcp-auth";

const TOKEN_PREFIX = "wfb_principal_v1";
const TOKEN_AUDIENCE = "workflow-builder-internal-workflows";
const DEFAULT_TTL_SECONDS = 5 * 60;

type AssertionPayload = WorkflowMcpPrincipalAssertion & {
  v: 1;
  aud: typeof TOKEN_AUDIENCE;
  iat: number;
  exp: number;
};

function signingSecret(): string {
  const secret =
    process.env.WORKFLOW_MCP_SIGNING_SECRET?.trim() ||
    process.env.JWT_SIGNING_KEY?.trim();
  if (!secret) {
    throw new Error(
      "WORKFLOW_MCP_SIGNING_SECRET or JWT_SIGNING_KEY is required for Workflow MCP principal assertions",
    );
  }
  return secret;
}

function signature(payload: string): Buffer {
  return createHmac("sha256", signingSecret())
    .update(`${TOKEN_PREFIX}.${payload}`)
    .digest();
}

function positiveTtlSeconds(): number {
  const configured = Number.parseInt(
    process.env.WORKFLOW_MCP_PRINCIPAL_ASSERTION_TTL_SECONDS ?? "",
    10,
  );
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_TTL_SECONDS;
}

export function mintWorkflowMcpPrincipalAssertion(
  principal: WorkflowMcpPrincipalAssertion,
  now = new Date(),
): string {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const payload: AssertionPayload = {
    v: 1,
    aud: TOKEN_AUDIENCE,
    userId: principal.userId,
    projectId: principal.projectId,
    sessionId: principal.sessionId,
    scopes: [...new Set(principal.scopes)].sort(),
    capabilities: principal.capabilities,
    iat: issuedAt,
    exp: issuedAt + positiveTtlSeconds(),
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return `${TOKEN_PREFIX}.${encoded}.${signature(encoded).toString("base64url")}`;
}

export function verifyWorkflowMcpPrincipalAssertion(
  token: string,
  now = new Date(),
): WorkflowMcpPrincipalAssertion | null {
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
    ) as Partial<AssertionPayload>;
    const nowSeconds = Math.floor(now.getTime() / 1000);
    if (
      payload.v !== 1 ||
      payload.aud !== TOKEN_AUDIENCE ||
      typeof payload.userId !== "string" ||
      !payload.userId ||
      typeof payload.projectId !== "string" ||
      !payload.projectId ||
      (payload.sessionId !== null && typeof payload.sessionId !== "string") ||
      !Array.isArray(payload.scopes) ||
      payload.scopes.some((scope) => typeof scope !== "string" || !scope) ||
      !payload.capabilities ||
      !Number.isInteger(payload.capabilities.scriptDepth) ||
      payload.capabilities.scriptDepth < 0 ||
      (payload.capabilities.teamId !== null &&
        (typeof payload.capabilities.teamId !== "string" ||
          !payload.capabilities.teamId)) ||
      !["none", "lead", "member"].includes(payload.capabilities.teamRole) ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number" ||
      payload.iat > nowSeconds + 60 ||
      payload.exp <= nowSeconds
    ) {
      return null;
    }
    return {
      userId: payload.userId,
      projectId: payload.projectId,
      sessionId: payload.sessionId ?? null,
      scopes: [...new Set(payload.scopes)],
      capabilities: payload.capabilities,
    };
  } catch {
    return null;
  }
}

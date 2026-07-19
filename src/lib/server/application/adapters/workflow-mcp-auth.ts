import {
  mintWorkflowMcpPrincipalAssertion,
  verifyWorkflowMcpPrincipalAssertion,
} from "$lib/server/workflow-mcp-principal-assertion";
import {
  mintWorkflowMcpSessionToken,
  verifyWorkflowMcpSessionToken,
  verifyWorkflowMcpSessionTokenForRefresh,
} from "$lib/server/workflow-mcp-session-token";
import type {
  WorkflowMcpPrincipalAssertion,
  WorkflowMcpPrincipalAssertionSigner,
  WorkflowMcpPrincipalAssertionVerifier,
  WorkflowMcpSessionIdentity,
  WorkflowMcpSessionTokenSigner,
  WorkflowMcpSessionTokenRefreshVerifier,
  WorkflowMcpSessionTokenVerifier,
  LegacyWorkflowRuntimeCompatibilityPolicy,
} from "$lib/server/application/ports/workflow-mcp-auth";

const MAX_LEGACY_RUNTIME_COMPATIBILITY_MS = 48 * 60 * 60 * 1000;

export class EnvironmentLegacyWorkflowRuntimeCompatibilityPolicy implements LegacyWorkflowRuntimeCompatibilityPolicy {
  constructor(private readonly now: () => Date = () => new Date()) {}

  isEnabled(): boolean {
    const raw = process.env.WORKFLOW_MCP_LEGACY_RUNTIME_COMPAT_UNTIL?.trim();
    if (!raw) return false;
    const cutoff = Date.parse(raw);
    const remaining = cutoff - this.now().getTime();
    return (
      Number.isFinite(cutoff) &&
      remaining > 0 &&
      remaining <= MAX_LEGACY_RUNTIME_COMPATIBILITY_MS
    );
  }
}

export class HmacWorkflowMcpSessionTokenAdapter
  implements
    WorkflowMcpSessionTokenSigner,
    WorkflowMcpSessionTokenVerifier,
    WorkflowMcpSessionTokenRefreshVerifier
{
  sign(identity: WorkflowMcpSessionIdentity): string {
    return mintWorkflowMcpSessionToken(identity);
  }

  verify(token: string): WorkflowMcpSessionIdentity | null {
    return verifyWorkflowMcpSessionToken(token);
  }

  verifyForRefresh(token: string): WorkflowMcpSessionIdentity | null {
    return verifyWorkflowMcpSessionTokenForRefresh(token);
  }
}

export class HmacWorkflowMcpPrincipalAssertionAdapter
  implements
    WorkflowMcpPrincipalAssertionSigner,
    WorkflowMcpPrincipalAssertionVerifier
{
  sign(principal: WorkflowMcpPrincipalAssertion): string {
    return mintWorkflowMcpPrincipalAssertion(principal);
  }

  verify(token: string): WorkflowMcpPrincipalAssertion | null {
    return verifyWorkflowMcpPrincipalAssertion(token);
  }
}

import type {
  LegacyWorkflowRuntimeCompatibilityPolicy,
  LegacyWorkflowRuntimeResource,
  LegacyWorkflowRuntimeResourceReader,
  WorkflowMcpPrincipalAssertion,
  WorkflowMcpPrincipalAssertionVerifier,
  WorkflowMcpSessionOwnerReader,
} from "./ports/workflow-mcp-auth";
import {
  platformSessionScopesForRole,
  type ApplicationWorkflowMcpPrincipalService,
} from "./workflow-mcp-principal";
import { workflowMcpSessionIsTerminal } from "./workflow-mcp-session-policy";

export type InternalWorkflowPrincipal = WorkflowMcpPrincipalAssertion;

export type InternalWorkflowPrincipalResult =
  | { ok: true; principal: InternalWorkflowPrincipal }
  | { ok: false; status: 400 | 403 | 404; error: string };

export class ApplicationInternalWorkflowPrincipalService {
  constructor(
    private readonly deps: {
      principalAssertions: WorkflowMcpPrincipalAssertionVerifier;
      sessionOwners: WorkflowMcpSessionOwnerReader;
      platformPrincipals: Pick<
        ApplicationWorkflowMcpPrincipalService,
        "resolve"
      >;
      legacyResources: LegacyWorkflowRuntimeResourceReader;
      legacyPolicy: LegacyWorkflowRuntimeCompatibilityPolicy;
    },
  ) {}

  async authorize(input: {
    assertionToken?: string;
    platformToken?: string;
    legacyUserId?: string;
    legacyProjectId?: string;
    sessionId: string | null;
    requiredScope?: string;
    legacyResource?: LegacyWorkflowRuntimeResource;
  }): Promise<InternalWorkflowPrincipalResult> {
    if (input.legacyUserId || input.legacyProjectId) {
      return {
        ok: false,
        status: 400,
        error:
          "Unsigned Workflow MCP principal headers are not accepted; use a BFF-issued principal assertion",
      };
    }

    if (input.assertionToken && input.platformToken) {
      return {
        ok: false,
        status: 400,
        error:
          "Use either a BFF-issued principal assertion or a signed platform session credential, not both",
      };
    }

    if (input.assertionToken) {
      return this.authorizeAssertion(input);
    }

    if (!input.platformToken) {
      if (input.legacyResource) return this.authorizeLegacyResource(input);
      return {
        ok: false,
        status: 400,
        error:
          "An authenticated workspace principal or trusted platform session is required",
      };
    }
    if (!input.sessionId) {
      return {
        ok: false,
        status: 400,
        error: "A signed platform session credential requires session lineage",
      };
    }

    const resolved = await this.deps.platformPrincipals.resolve({
      authorizationHeader: null,
      platformToken: input.platformToken,
      requestedSessionId: input.sessionId,
    });
    if (!resolved.ok) {
      return {
        ok: false,
        status:
          resolved.status === 400 || resolved.status === 404
            ? resolved.status
            : 403,
        error: resolved.error,
      };
    }
    if (
      input.requiredScope &&
      !resolved.principal.scopes.includes(input.requiredScope)
    ) {
      return {
        ok: false,
        status: 403,
        error: `The Workflow MCP principal lacks ${input.requiredScope} scope`,
      };
    }

    return {
      ok: true,
      principal: {
        userId: resolved.principal.userId,
        projectId: resolved.principal.projectId,
        sessionId: resolved.principal.sessionId,
        scopes: resolved.principal.scopes,
        capabilities: resolved.principal.capabilities,
      },
    };
  }

  private async authorizeLegacyResource(input: {
    sessionId: string | null;
    requiredScope?: string;
    legacyResource?: LegacyWorkflowRuntimeResource;
  }): Promise<InternalWorkflowPrincipalResult> {
    const resource = input.legacyResource;
    if (!resource || !this.deps.legacyPolicy.isEnabled()) {
      return {
        ok: false,
        status: 400,
        error: "A signed Workflow MCP principal is required",
      };
    }
    if (
      resource.kind === "session" &&
      input.sessionId &&
      input.sessionId !== resource.id
    ) {
      return {
        ok: false,
        status: 403,
        error: "Legacy runtime session lineage does not match the resource",
      };
    }

    const owner =
      resource.kind === "session"
        ? await this.deps.legacyResources.getSessionFileOwner(resource.id)
        : await this.deps.legacyResources.getWorkflowExecutionOwner(
            resource.id,
          );
    if (!owner) {
      return {
        ok: false,
        status: 404,
        error: "Legacy runtime resource not found",
      };
    }
    if (resource.kind === "session" && workflowMcpSessionIsTerminal(owner)) {
      return {
        ok: false,
        status: 403,
        error: "Legacy runtime session is no longer active",
      };
    }
    if (!owner.projectId) {
      return {
        ok: false,
        status: 403,
        error: "Legacy runtime resource is not workspace scoped",
      };
    }
    const membership =
      await this.deps.legacyResources.getWorkspaceProjectMembershipDetail({
        projectId: owner.projectId,
        userId: owner.userId,
      });
    const active =
      membership?.selfRole &&
      (await this.deps.legacyResources.hasActiveWorkspaceProjectMembership({
        projectId: owner.projectId,
        userId: owner.userId,
      }));
    const allowedScopes = membership?.selfRole
      ? platformSessionScopesForRole(membership.selfRole)
      : null;
    if (
      !active ||
      !allowedScopes ||
      (input.requiredScope && !allowedScopes.includes(input.requiredScope))
    ) {
      return {
        ok: false,
        status: 403,
        error: "Legacy runtime resource owner is not authorized",
      };
    }

    console.warn(
      `[workflow-mcp-auth] accepted bounded legacy ${resource.kind} credential for ${resource.id}`,
    );
    return {
      ok: true,
      principal: {
        userId: owner.userId,
        projectId: owner.projectId,
        sessionId: resource.kind === "session" ? resource.id : null,
        scopes: input.requiredScope ? [input.requiredScope] : [],
        capabilities: {
          scriptDepth: 1,
          teamId: null,
          teamRole: "none",
        },
      },
    };
  }

  private async authorizeAssertion(input: {
    assertionToken?: string;
    sessionId: string | null;
    requiredScope?: string;
  }): Promise<InternalWorkflowPrincipalResult> {
    const assertion = this.deps.principalAssertions.verify(
      input.assertionToken ?? "",
    );
    if (!assertion) {
      return {
        ok: false,
        status: 403,
        error: "The Workflow MCP principal assertion is invalid or expired",
      };
    }
    if (
      input.requiredScope &&
      !assertion.scopes.includes(input.requiredScope)
    ) {
      return {
        ok: false,
        status: 403,
        error: `The Workflow MCP principal lacks ${input.requiredScope} scope`,
      };
    }
    if (input.sessionId && input.sessionId !== assertion.sessionId) {
      return {
        ok: false,
        status: 403,
        error:
          "Session lineage does not match the signed Workflow MCP principal",
      };
    }

    if (assertion.sessionId) {
      const owner = await this.deps.sessionOwners.getSessionFileOwner(
        assertion.sessionId,
      );
      if (!owner) {
        return {
          ok: false,
          status: 404,
          error: `Session ${assertion.sessionId} not found`,
        };
      }
      if (workflowMcpSessionIsTerminal(owner)) {
        return {
          ok: false,
          status: 403,
          error: "The Workflow MCP session is no longer active",
        };
      }
      if (
        owner.userId !== assertion.userId ||
        owner.projectId !== assertion.projectId
      ) {
        return {
          ok: false,
          status: 403,
          error:
            "Session context does not belong to the authenticated workspace principal",
        };
      }
    }

    return { ok: true, principal: assertion };
  }
}

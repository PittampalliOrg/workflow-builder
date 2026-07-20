import type {
  WorkflowMcpPrincipalAssertionSigner,
  WorkflowMcpPrincipalDataPort,
  WorkflowMcpSessionCapabilities,
  WorkflowMcpSessionIdentity,
  WorkflowMcpSessionTokenRefreshVerifier,
  WorkflowMcpSessionTokenSigner,
  WorkflowMcpSessionTokenVerifier,
  WorkflowMcpTeamMemberReader,
} from "./ports/workflow-mcp-auth";
import { workflowMcpSessionIsTerminal } from "./workflow-mcp-session-policy";

const PLATFORM_SESSION_BASE_SCOPES = [
  "session:team",
  // Retained while older workflow-mcp-server pods still gate trace tools on
  // this claim. Current trace reads authorize with workflow:read.
  "session:trace",
];

const PLATFORM_SESSION_AUTHOR_SCOPES = [
  "workflow:read",
  "workflow:write",
  "workflow:execute",
  "agent:write",
  ...PLATFORM_SESSION_BASE_SCOPES,
];

const NO_PLATFORM_CAPABILITIES: WorkflowMcpSessionCapabilities = {
  scriptDepth: 0,
  teamId: null,
  teamRole: "none",
};

export type WorkflowMcpResolvedPrincipal = {
  authMode: "workspace_api_key" | "platform_session";
  apiKeyId?: string;
  userId: string;
  projectId: string;
  workspace: { id: string; slug: string; name: string };
  scopes: string[];
  sessionId: string | null;
  capabilities: WorkflowMcpSessionCapabilities;
  principalAssertion: string;
};

type WorkflowMcpPrincipalError = {
  ok: false;
  status: number;
  code: string;
  error: string;
};

export type WorkflowMcpPrincipalResolutionResult =
  | { ok: true; principal: WorkflowMcpResolvedPrincipal }
  | WorkflowMcpPrincipalError;

export type WorkflowMcpSessionRefreshResult =
  | {
      ok: true;
      principal: WorkflowMcpResolvedPrincipal;
      sessionToken: string;
    }
  | WorkflowMcpPrincipalError;

export function platformSessionScopesForRole(role: string): string[] | null {
  switch (role) {
    case "ADMIN":
    case "EDITOR":
      return PLATFORM_SESSION_AUTHOR_SCOPES;
    case "OPERATOR":
      return [
        "workflow:read",
        "workflow:execute",
        ...PLATFORM_SESSION_BASE_SCOPES,
      ];
    case "VIEWER":
      return ["workflow:read", "session:trace"];
    default:
      return null;
  }
}

export class ApplicationWorkflowMcpPrincipalService {
  constructor(
    private readonly deps: {
      data: WorkflowMcpPrincipalDataPort;
      teamMembers: WorkflowMcpTeamMemberReader;
      sessionTokens: WorkflowMcpSessionTokenVerifier &
        WorkflowMcpSessionTokenRefreshVerifier &
        WorkflowMcpSessionTokenSigner;
      principalAssertions: WorkflowMcpPrincipalAssertionSigner;
    },
  ) {}

  async resolve(input: {
    authorizationHeader: string | null;
    platformToken: string;
    requestedSessionId: string;
  }): Promise<WorkflowMcpPrincipalResolutionResult> {
    if (input.authorizationHeader && input.platformToken) {
      return this.error(
        400,
        "ambiguous_workflow_mcp_credential",
        "Use either a workspace API key or a platform session token, not both",
      );
    }

    if (input.authorizationHeader) {
      return this.resolveWorkspaceApiKey({
        authorizationHeader: input.authorizationHeader,
        requestedSessionId: input.requestedSessionId,
      });
    }

    if (input.platformToken) {
      return this.resolvePlatformSession(input);
    }

    return this.error(
      401,
      "workflow_mcp_auth_required",
      "Authenticate with a workspace API key; a session ID alone is not a credential",
    );
  }

  private async resolveWorkspaceApiKey(input: {
    authorizationHeader: string;
    requestedSessionId: string;
  }): Promise<WorkflowMcpPrincipalResolutionResult> {
    const resolution = await this.deps.data.resolveApiKey({
      authorizationHeader: input.authorizationHeader,
    });
    if (!resolution.valid) {
      return this.error(
        resolution.statusCode,
        "invalid_workflow_mcp_api_key",
        resolution.error,
      );
    }
    if (!resolution.projectId) {
      return this.error(
        403,
        "workspace_key_required",
        "Create a new API key from a Workflow Builder workspace",
      );
    }

    if (input.requestedSessionId) {
      const owner = await this.deps.data.getSessionFileOwner(
        input.requestedSessionId,
      );
      if (!owner) {
        return this.error(
          404,
          "session_not_found",
          "Session context was not found",
        );
      }
      if (workflowMcpSessionIsTerminal(owner)) {
        return this.error(
          403,
          "session_inactive",
          "Session context is no longer active",
        );
      }
      if (
        owner.userId !== resolution.userId ||
        owner.projectId !== resolution.projectId
      ) {
        return this.error(
          403,
          "session_principal_mismatch",
          "Session context does not belong to this API key's workspace principal",
        );
      }
    }

    const workspace = await this.deps.data.getWorkspaceProjectMembershipDetail({
      projectId: resolution.projectId,
      userId: resolution.userId,
    });
    const activeMembership =
      workspace?.selfRole &&
      (await this.deps.data.hasActiveWorkspaceProjectMembership({
        projectId: resolution.projectId,
        userId: resolution.userId,
      }));
    if (!activeMembership) {
      return this.error(
        403,
        "workspace_membership_required",
        "The API key owner is no longer a member of this workspace",
      );
    }

    return this.authenticated({
      authMode: "workspace_api_key",
      apiKeyId: resolution.apiKeyId,
      userId: resolution.userId,
      projectId: resolution.projectId,
      workspace,
      scopes: resolution.scopes,
      sessionId: input.requestedSessionId || null,
      capabilities: NO_PLATFORM_CAPABILITIES,
    });
  }

  private async resolvePlatformSession(input: {
    platformToken: string;
    requestedSessionId: string;
  }): Promise<WorkflowMcpPrincipalResolutionResult> {
    const identity = this.deps.sessionTokens.verify(input.platformToken);
    if (!identity) {
      return this.error(
        401,
        "invalid_platform_session_token",
        "The platform session credential is invalid",
      );
    }
    return this.resolvePlatformIdentity(identity, input.requestedSessionId);
  }

  async refreshPlatformSession(input: {
    platformToken: string;
    requestedSessionId: string;
  }): Promise<WorkflowMcpSessionRefreshResult> {
    const identity = this.deps.sessionTokens.verifyForRefresh(
      input.platformToken,
    );
    if (!identity) {
      return this.error(
        401,
        "invalid_platform_session_refresh_token",
        "The platform session credential cannot be refreshed",
      );
    }
    const resolved = await this.resolvePlatformIdentity(
      identity,
      input.requestedSessionId,
    );
    if (!resolved.ok) return resolved;
    return {
      ...resolved,
      sessionToken: this.deps.sessionTokens.sign({
        userId: resolved.principal.userId,
        projectId: resolved.principal.projectId,
        sessionId: resolved.principal.sessionId ?? identity.sessionId,
        capabilities: resolved.principal.capabilities,
      }),
    };
  }

  private async resolvePlatformIdentity(
    identity: WorkflowMcpSessionIdentity,
    requestedSessionId: string,
  ): Promise<WorkflowMcpPrincipalResolutionResult> {
    if (!requestedSessionId || requestedSessionId !== identity.sessionId) {
      return this.error(
        403,
        "session_token_mismatch",
        "X-Wfb-Session-Id must match the signed platform session token",
      );
    }

    const owner = await this.deps.data.getSessionFileOwner(identity.sessionId);
    if (
      !owner ||
      owner.userId !== identity.userId ||
      owner.projectId !== identity.projectId
    ) {
      return this.error(
        403,
        "platform_session_principal_mismatch",
        "The platform session no longer belongs to the signed principal",
      );
    }
    if (workflowMcpSessionIsTerminal(owner)) {
      return this.error(
        403,
        "platform_session_inactive",
        "The platform session is no longer active",
      );
    }

    const workspace = await this.deps.data.getWorkspaceProjectMembershipDetail({
      projectId: identity.projectId,
      userId: identity.userId,
    });
    const activeMembership =
      workspace?.selfRole &&
      (await this.deps.data.hasActiveWorkspaceProjectMembership({
        projectId: identity.projectId,
        userId: identity.userId,
      }));
    if (!activeMembership || !workspace?.selfRole) {
      return this.error(
        403,
        "workspace_membership_required",
        "The platform session owner is no longer a member of this workspace",
      );
    }
    const platformRole = workspace.selfRole;
    const platformScopes = platformSessionScopesForRole(platformRole);
    if (!platformScopes) {
      return this.error(
        403,
        "workspace_role_unsupported",
        "The platform session owner has no supported workspace role",
      );
    }

    let capabilities = identity.capabilities;
    if (platformRole === "VIEWER") {
      capabilities = {
        ...capabilities,
        teamId: null,
        teamRole: "none",
      };
    } else if (capabilities.teamRole === "member") {
      const team = capabilities.teamId
        ? await this.deps.teamMembers.getTeam(capabilities.teamId)
        : null;
      const member = await this.deps.teamMembers.getMemberBySession(
        identity.sessionId,
      );
      if (
        !team ||
        team.status !== "active" ||
        !member ||
        member.team_id !== capabilities.teamId ||
        member.role === "lead" ||
        member.status === "shutdown" ||
        member.status === "failed"
      ) {
        capabilities = {
          ...capabilities,
          teamId: null,
          teamRole: "none",
        };
      }
    } else if (capabilities.teamRole === "lead") {
      const expectedInitialTeamId = `team-${identity.sessionId}`;
      const team = capabilities.teamId
        ? await this.deps.teamMembers.getTeam(capabilities.teamId)
        : null;
      const validInitialLead =
        !team && capabilities.teamId === expectedInitialTeamId;
      const validExistingLead =
        team?.status === "active" &&
        team.lead_session_id === identity.sessionId;
      if (!validInitialLead && !validExistingLead) {
        capabilities = {
          ...capabilities,
          teamId: null,
          teamRole: "none",
        };
      }
    }

    return this.authenticated({
      authMode: "platform_session",
      userId: identity.userId,
      projectId: identity.projectId,
      workspace,
      scopes: platformScopes,
      sessionId: identity.sessionId,
      capabilities,
    });
  }

  private authenticated(input: {
    authMode: "workspace_api_key" | "platform_session";
    apiKeyId?: string;
    userId: string;
    projectId: string;
    workspace: {
      id: string;
      externalId: string;
      displayName: string;
    };
    scopes: string[];
    sessionId: string | null;
    capabilities: WorkflowMcpSessionCapabilities;
  }): WorkflowMcpPrincipalResolutionResult {
    return {
      ok: true,
      principal: {
        authMode: input.authMode,
        ...(input.apiKeyId ? { apiKeyId: input.apiKeyId } : {}),
        userId: input.userId,
        projectId: input.projectId,
        workspace: {
          id: input.workspace.id,
          slug: input.workspace.externalId,
          name: input.workspace.displayName,
        },
        scopes: input.scopes,
        sessionId: input.sessionId,
        capabilities: input.capabilities,
        principalAssertion: this.deps.principalAssertions.sign({
          userId: input.userId,
          projectId: input.projectId,
          sessionId: input.sessionId,
          scopes: input.scopes,
          capabilities: input.capabilities,
        }),
      },
    };
  }

  private error(
    status: number,
    code: string,
    error: string,
  ): WorkflowMcpPrincipalError {
    return { ok: false, status, code, error };
  }
}

import type { TeamStore } from "./ports/teams";
import type { WorkflowMcpSessionCapabilities } from "./ports/workflow-mcp-auth";
import type {
  ApplicationInternalWorkflowPrincipalService,
  InternalWorkflowPrincipal,
} from "./internal-workflow-principal";

export const WORKFLOW_TEAM_SCRIPT_SYSTEM_PRINCIPAL =
  "workflow-orchestrator-team-script" as const;

export type TeamActionRequiredRole = "any" | "lead" | "member";

export type TeamActionPrincipal = InternalWorkflowPrincipal & {
  sessionId: string;
  capabilities: WorkflowMcpSessionCapabilities;
};

export type TeamActionAuthorizationResult =
  | { ok: true; principal: TeamActionPrincipal; lane: "user" | "system" }
  | { ok: false; status: 400 | 403 | 404; error: string };

type TeamActionPolicy = {
  teamId: string;
  sessionId: string | null;
  requiredRole?: TeamActionRequiredRole;
  allowUnformedLeadTeam?: boolean;
};

/**
 * Authorizes team commands at the application boundary. HTTP adapters may
 * supply either a short-lived signed user assertion or the named workflow
 * orchestrator system lane; body fields never establish the acting identity.
 */
export class ApplicationTeamActionAuthorizationService {
  constructor(
    private readonly deps: {
      workflowPrincipals: Pick<
        ApplicationInternalWorkflowPrincipalService,
        "authorize"
      >;
      teams: Pick<
        TeamStore,
        | "getTeam"
        | "getMemberBySession"
        | "getSessionUserId"
        | "getSessionProjectId"
      >;
    },
  ) {}

  async authorizeUser(
    input: TeamActionPolicy & {
      assertionToken?: string;
      platformToken?: string;
      legacyUserId?: string;
      legacyProjectId?: string;
    },
  ): Promise<TeamActionAuthorizationResult> {
    const authorization = await this.deps.workflowPrincipals.authorize({
      assertionToken: input.assertionToken,
      platformToken: input.platformToken,
      legacyUserId: input.legacyUserId,
      legacyProjectId: input.legacyProjectId,
      sessionId: input.sessionId,
      requiredScope: "session:team",
    });
    if (!authorization.ok) return authorization;
    if (!authorization.principal.sessionId) {
      return this.error(403, "Team actions require a signed session principal");
    }

    const principal = authorization.principal as TeamActionPrincipal;
    if (
      !principal.capabilities ||
      principal.capabilities.teamId !== input.teamId ||
      principal.capabilities.teamRole === "none"
    ) {
      return this.error(
        403,
        "Team lineage does not match the signed Workflow MCP capability",
      );
    }
    const roleError = this.validateRequiredRole(
      principal.capabilities.teamRole,
      input.requiredRole ?? "any",
    );
    if (roleError) return roleError;

    const binding = await this.validateLiveBinding({
      teamId: input.teamId,
      sessionId: principal.sessionId,
      teamRole: principal.capabilities.teamRole,
      allowUnformedLeadTeam: input.allowUnformedLeadTeam === true,
    });
    if (!binding.ok) return binding;
    return { ok: true, principal, lane: "user" };
  }

  async authorizeSystem(
    input: TeamActionPolicy & {
      systemPrincipal?: string;
    },
  ): Promise<TeamActionAuthorizationResult> {
    if (input.systemPrincipal !== WORKFLOW_TEAM_SCRIPT_SYSTEM_PRINCIPAL) {
      return this.error(403, "Unknown internal team system principal");
    }
    if (!input.sessionId) {
      return this.error(400, "The team system lane requires a session ID");
    }

    const team = await this.deps.teams.getTeam(input.teamId);
    if (!team || team.status !== "active") {
      return this.error(404, "Active team not found");
    }
    const member = await this.deps.teams.getMemberBySession(input.sessionId);
    const teamRole =
      team.lead_session_id === input.sessionId
        ? "lead"
        : member?.team_id === input.teamId &&
            member.role !== "lead" &&
            member.status !== "shutdown" &&
            member.status !== "failed"
          ? "member"
          : "none";
    if (teamRole === "none") {
      return this.error(403, "The system session is not an active team member");
    }
    const roleError = this.validateRequiredRole(
      teamRole,
      input.requiredRole ?? "any",
    );
    if (roleError) return roleError;

    const [userId, projectId] = await Promise.all([
      this.deps.teams.getSessionUserId(input.sessionId),
      this.deps.teams.getSessionProjectId(input.sessionId),
    ]);
    if (!userId || !projectId) {
      return this.error(404, "The team system session has no workspace owner");
    }
    return {
      ok: true,
      lane: "system",
      principal: {
        userId,
        projectId,
        sessionId: input.sessionId,
        scopes: ["session:team"],
        capabilities: {
          scriptDepth: 0,
          teamId: input.teamId,
          teamRole,
        },
      },
    };
  }

  private async validateLiveBinding(input: {
    teamId: string;
    sessionId: string;
    teamRole: "lead" | "member";
    allowUnformedLeadTeam: boolean;
  }): Promise<{ ok: true } | { ok: false; status: 403 | 404; error: string }> {
    const team = await this.deps.teams.getTeam(input.teamId);
    if (!team) {
      const validInitialLead =
        input.allowUnformedLeadTeam &&
        input.teamRole === "lead" &&
        input.teamId === `team-${input.sessionId}`;
      return validInitialLead
        ? { ok: true }
        : this.error(404, "Active team not found");
    }
    if (team.status !== "active") {
      return this.error(403, "The team is no longer active");
    }
    if (input.teamRole === "lead") {
      return team.lead_session_id === input.sessionId
        ? { ok: true }
        : this.error(403, "The signed session is not this team's lead");
    }

    const member = await this.deps.teams.getMemberBySession(input.sessionId);
    return member?.team_id === input.teamId &&
      member.role !== "lead" &&
      member.status !== "shutdown" &&
      member.status !== "failed"
      ? { ok: true }
      : this.error(403, "The signed session is not an active team member");
  }

  private validateRequiredRole(
    actual: "lead" | "member",
    required: TeamActionRequiredRole,
  ): { ok: false; status: 403; error: string } | null {
    if (required === "any" || actual === required) return null;
    return this.error(403, `This team action requires the ${required} role`);
  }

  private error<const Status extends 400 | 403 | 404>(
    status: Status,
    error: string,
  ): { ok: false; status: Status; error: string } {
    return { ok: false, status, error };
  }
}

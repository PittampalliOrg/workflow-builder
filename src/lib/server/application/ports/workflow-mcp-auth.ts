import type {
  ApiKeyResolutionResult,
  WorkspaceProjectMembershipDetail,
} from "./platform";

export type WorkflowMcpSessionCapabilities = {
  scriptDepth: number;
  teamId: string | null;
  teamRole: "none" | "lead" | "member";
};

export type WorkflowMcpSessionIdentity = {
  userId: string;
  projectId: string;
  sessionId: string;
  capabilities: WorkflowMcpSessionCapabilities;
};

export type WorkflowMcpPrincipalAssertion = {
  userId: string;
  projectId: string;
  sessionId: string | null;
  scopes: string[];
  capabilities: WorkflowMcpSessionCapabilities;
};

export type WorkflowMcpSessionOwner = {
  id: string;
  userId: string;
  projectId: string | null;
  status?: string;
  completedAt?: Date | string | null;
};

export interface WorkflowMcpSessionTokenSigner {
  sign(identity: WorkflowMcpSessionIdentity): string;
}

export interface WorkflowMcpSessionTokenVerifier {
  verify(token: string): WorkflowMcpSessionIdentity | null;
}

export interface WorkflowMcpSessionTokenRefreshVerifier {
  verifyForRefresh(token: string): WorkflowMcpSessionIdentity | null;
}

export interface WorkflowMcpPrincipalAssertionSigner {
  sign(principal: WorkflowMcpPrincipalAssertion): string;
}

export interface WorkflowMcpPrincipalAssertionVerifier {
  verify(token: string): WorkflowMcpPrincipalAssertion | null;
}

export interface WorkflowMcpPrincipalDataPort {
  resolveApiKey(input: {
    authorizationHeader: string | null;
  }): Promise<ApiKeyResolutionResult>;
  getSessionFileOwner(
    sessionId: string,
  ): Promise<WorkflowMcpSessionOwner | null>;
  getWorkspaceProjectMembershipDetail(input: {
    projectId: string;
    userId: string;
  }): Promise<WorkspaceProjectMembershipDetail | null>;
  hasActiveWorkspaceProjectMembership(input: {
    projectId: string;
    userId: string;
  }): Promise<boolean>;
}

export interface WorkflowMcpTeamMemberReader {
  getTeam(teamId: string): Promise<{
    id: string;
    lead_session_id: string;
    status: string;
  } | null>;
  getMemberBySession(sessionId: string): Promise<{
    team_id: string;
    role: string;
    status: string;
  } | null>;
}

export interface WorkflowMcpSessionOwnerReader {
  getSessionFileOwner(
    sessionId: string,
  ): Promise<WorkflowMcpSessionOwner | null>;
}

export type LegacyWorkflowRuntimeResource =
  | { kind: "session"; id: string }
  | { kind: "workflow_execution"; id: string };

export interface LegacyWorkflowRuntimeCompatibilityPolicy {
  isEnabled(): boolean;
}

export interface LegacyWorkflowRuntimeResourceReader extends WorkflowMcpSessionOwnerReader {
  getWorkflowExecutionOwner(executionId: string): Promise<{
    id: string;
    userId: string;
    projectId: string | null;
  } | null>;
  getWorkspaceProjectMembershipDetail(input: {
    projectId: string;
    userId: string;
  }): Promise<WorkspaceProjectMembershipDetail | null>;
  hasActiveWorkspaceProjectMembership(input: {
    projectId: string;
    userId: string;
  }): Promise<boolean>;
}

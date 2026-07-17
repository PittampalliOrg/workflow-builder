export type WorkflowTargetAuthIdentity = {
  userId: string;
  email: string;
  platformId: string;
  projectId: string;
  tokenVersion: number;
};

export interface WorkflowTargetAuthIdentityRepository {
  resolveExecutionOwner(
    executionId: string,
  ): Promise<WorkflowTargetAuthIdentity | null>;
}

export interface WorkflowTargetAuthAccessTokenIssuer {
  issue(identity: WorkflowTargetAuthIdentity): Promise<string>;
}

/**
 * Mints an execution-scoped browser target credential from authoritative
 * workflow ownership. Missing identity/signing infrastructure deliberately
 * produces no token: public browser targets must remain usable, while a stale
 * or mismatched credential is never forwarded.
 */
export class ApplicationWorkflowTargetAuthService {
  constructor(
    private readonly deps: {
      identities: WorkflowTargetAuthIdentityRepository;
      tokens: WorkflowTargetAuthAccessTokenIssuer;
    },
  ) {}

  async mintAccessToken(input: {
    executionId: string;
    expectedUserId: string;
    expectedProjectId: string | null;
  }): Promise<string | null> {
    const executionId = input.executionId.trim();
    if (!executionId) return null;

    try {
      const identity =
        await this.deps.identities.resolveExecutionOwner(executionId);
      if (!identity) return null;
      if (identity.userId !== input.expectedUserId) return null;
      if (
        !input.expectedProjectId ||
        identity.projectId !== input.expectedProjectId
      ) {
        return null;
      }
      return await this.deps.tokens.issue(identity);
    } catch {
      return null;
    }
  }
}

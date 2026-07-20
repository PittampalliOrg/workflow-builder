import type {
  WorkflowTargetAuthAssertionPort,
  WorkflowTargetAuthBindingPort,
  WorkflowTargetAuthCookieIssuer,
  WorkflowTargetAuthExchange,
  WorkflowTargetAuthIdentity,
  WorkflowTargetAuthIdentityRepository,
  WorkflowTargetAuthOriginProvider,
  WorkflowTargetAuthValidation,
} from "$lib/server/application/ports";

type ExpectedOwner = Readonly<{
  executionId: string;
  expectedUserId: string;
  expectedProjectId: string | null;
}>;

function isCurrentlyAuthorized(identity: WorkflowTargetAuthIdentity): boolean {
  return (
    identity.executionStatus === "running" &&
    identity.executionCompletedAt === null &&
    identity.executionStopRequestedAt === null &&
    identity.userStatus === "ACTIVE" &&
    Boolean(identity.projectMembershipId)
  );
}

function matchesExpectedOwner(
  identity: WorkflowTargetAuthIdentity,
  input: ExpectedOwner,
): boolean {
  return (
    isCurrentlyAuthorized(identity) &&
    identity.userId === input.expectedUserId &&
    Boolean(input.expectedProjectId) &&
    identity.projectId === input.expectedProjectId
  );
}

/**
 * Coordinates the browser target-auth capability without exposing signing,
 * persistence, JWT, or deployment-origin details to route handlers.
 */
export class ApplicationWorkflowTargetAuthService {
  constructor(
    private readonly deps: {
      identities: WorkflowTargetAuthIdentityRepository;
      assertions: WorkflowTargetAuthAssertionPort;
      bindings: WorkflowTargetAuthBindingPort;
      cookies: WorkflowTargetAuthCookieIssuer;
      origin: WorkflowTargetAuthOriginProvider;
    },
  ) {}

  private async resolveAuthorizedIdentity(
    input: Readonly<{ assertion: string; executionId: string }>,
  ): Promise<WorkflowTargetAuthIdentity | null> {
    const executionId = input.executionId.trim();
    if (!executionId || !input.assertion.trim()) return null;
    const claims = this.deps.assertions.verify(input.assertion.trim());
    if (!claims || claims.executionId !== executionId) return null;
    const identity =
      await this.deps.identities.resolveExecutionOwner(executionId);
    if (
      !identity ||
      !isCurrentlyAuthorized(identity) ||
      identity.userId !== claims.userId ||
      identity.projectId !== claims.projectId ||
      identity.tokenVersion !== claims.tokenVersion
    ) {
      return null;
    }
    return identity;
  }

  /**
   * Mint a purpose-limited proof for durable execution config. The proof is
   * useless without the bridge's INTERNAL_API_TOKEN and never authenticates a
   * user request directly.
   */
  async mintAssertion(input: ExpectedOwner): Promise<string | null> {
    const executionId = input.executionId.trim();
    if (!executionId) return null;

    try {
      const identity =
        await this.deps.identities.resolveExecutionOwner(executionId);
      if (!identity || !matchesExpectedOwner(identity, input)) return null;
      return this.deps.assertions.issue({
        executionId,
        userId: identity.userId,
        projectId: identity.projectId,
        tokenVersion: identity.tokenVersion,
      });
    } catch {
      return null;
    }
  }

  /**
   * Exchange a purpose proof just in time. Re-resolving the execution owner
   * makes user/project binding authoritative at exchange time and honors token
   * revocation before the short-lived cookie is issued.
   */
  async exchange(
    input: Readonly<{
      assertion: string;
      executionId: string;
    }>,
  ): Promise<WorkflowTargetAuthExchange | null> {
    try {
      const identity = await this.resolveAuthorizedIdentity(input);
      if (!identity) return null;
      const targetOrigin = this.deps.origin.getOrigin();
      const secure = new URL(targetOrigin).protocol === "https:";
      return {
        targetOrigin,
        cookie: await this.deps.cookies.issue(identity, { secure }),
      };
    } catch {
      return null;
    }
  }

  /** Revalidate a live browser capability without minting a UI credential. */
  async validate(
    input: Readonly<{ assertion: string; executionId: string }>,
  ): Promise<WorkflowTargetAuthValidation | null> {
    try {
      const identity = await this.resolveAuthorizedIdentity(input);
      if (!identity) return null;
      return {
        authorizationBinding: this.deps.bindings.derive({
          executionId: input.executionId.trim(),
          userId: identity.userId,
          projectId: identity.projectId,
          tokenVersion: identity.tokenVersion,
        }),
      };
    } catch {
      return null;
    }
  }
}

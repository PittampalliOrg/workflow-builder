import type {
  WorkflowTargetAuthAssertionPort,
  WorkflowTargetAuthCookieIssuer,
  WorkflowTargetAuthExchange,
  WorkflowTargetAuthIdentity,
  WorkflowTargetAuthIdentityRepository,
  WorkflowTargetAuthOriginProvider,
} from "$lib/server/application/ports";

type ExpectedOwner = Readonly<{
  executionId: string;
  expectedUserId: string;
  expectedProjectId: string | null;
}>;

function matchesExpectedOwner(
  identity: WorkflowTargetAuthIdentity,
  input: ExpectedOwner,
): boolean {
  return (
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
      cookies: WorkflowTargetAuthCookieIssuer;
      origin: WorkflowTargetAuthOriginProvider;
    },
  ) {}

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
    const executionId = input.executionId.trim();
    if (!executionId || !input.assertion.trim()) return null;

    try {
      const claims = this.deps.assertions.verify(input.assertion.trim());
      if (!claims || claims.executionId !== executionId) return null;
      const identity =
        await this.deps.identities.resolveExecutionOwner(executionId);
      if (
        !identity ||
        identity.userId !== claims.userId ||
        identity.projectId !== claims.projectId
      ) {
        return null;
      }
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
}

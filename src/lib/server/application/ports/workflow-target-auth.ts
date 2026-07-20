export type WorkflowTargetAuthIdentity = Readonly<{
  userId: string;
  email: string;
  platformId: string;
  projectId: string;
  tokenVersion: number;
  executionStatus: "pending" | "running" | "success" | "error" | "cancelled";
  executionCompletedAt: Date | null;
  executionStopRequestedAt: Date | null;
  userStatus: "ACTIVE" | "INACTIVE" | null;
  projectMembershipId: string | null;
}>;

export type WorkflowTargetAuthAssertionClaims = Readonly<{
  executionId: string;
  userId: string;
  projectId: string;
  tokenVersion: number;
}>;

export type WorkflowTargetAuthCookie = Readonly<{
  name: "wb_access_token";
  value: string;
  expiresAt: number;
  httpOnly: true;
  secure: boolean;
  sameSite: "Strict";
  path: "/";
}>;

export type WorkflowTargetAuthExchange = Readonly<{
  targetOrigin: string;
  cookie: WorkflowTargetAuthCookie;
}>;

export type WorkflowTargetAuthValidation = Readonly<{
  authorizationBinding: string;
}>;

export interface WorkflowTargetAuthIdentityRepository {
  resolveExecutionOwner(
    executionId: string,
  ): Promise<WorkflowTargetAuthIdentity | null>;
}

/** Purpose-specific proof carried by durable execution configuration. */
export interface WorkflowTargetAuthAssertionPort {
  issue(claims: WorkflowTargetAuthAssertionClaims): string;
  verify(assertion: string): WorkflowTargetAuthAssertionClaims | null;
}

/** Derives an opaque stable binding for one currently authorized run scope. */
export interface WorkflowTargetAuthBindingPort {
  derive(scope: WorkflowTargetAuthAssertionClaims): string;
}

/** Issues the short-lived UI cookie only after a successful bridge exchange. */
export interface WorkflowTargetAuthCookieIssuer {
  issue(
    identity: WorkflowTargetAuthIdentity,
    options: Readonly<{ secure: boolean }>,
  ): Promise<WorkflowTargetAuthCookie>;
}

/** Server-owned canonical origin that may receive the browser cookie. */
export interface WorkflowTargetAuthOriginProvider {
  getOrigin(): string;
}

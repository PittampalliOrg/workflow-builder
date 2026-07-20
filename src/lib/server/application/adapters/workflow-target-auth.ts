import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { env } from "$env/dynamic/private";
import {
  userIdentities,
  users,
  projectMembers,
  workflowExecutions,
  workflows,
} from "$lib/server/db/schema";
import { requirePostgresDb } from "$lib/server/application/adapters/postgres";
import type {
  WorkflowTargetAuthAssertionClaims,
  WorkflowTargetAuthAssertionPort,
  WorkflowTargetAuthBindingPort,
  WorkflowTargetAuthCookie,
  WorkflowTargetAuthCookieIssuer,
  WorkflowTargetAuthIdentity,
  WorkflowTargetAuthIdentityRepository,
  WorkflowTargetAuthOriginProvider,
} from "$lib/server/application/ports";
import { generateAccessToken } from "$lib/server/auth-jwt";

const ASSERTION_PREFIX = "wfb_browser_auth_v1";
const ASSERTION_AUDIENCE = "workflow-builder-browser-target-auth";
const ASSERTION_PURPOSE = "browser-target-auth";
const ASSERTION_SIGNING_KEY_CONTEXT =
  "workflow-builder/browser-target-auth/assertion/v1";
const AUTHORIZATION_BINDING_PREFIX = "wfb_browser_binding_v1";
const AUTHORIZATION_BINDING_KEY_CONTEXT =
  "workflow-builder/browser-target-auth/binding/v1";
const DEFAULT_ASSERTION_TTL_SECONDS = 60 * 60;
const MAX_ASSERTION_TTL_SECONDS = 60 * 60;
const MAX_ASSERTION_BYTES = 2_048;
const MAX_CLOCK_SKEW_SECONDS = 60;

const DEFAULT_COOKIE_TTL_SECONDS = 30 * 60;
const MIN_COOKIE_TTL_SECONDS = 5 * 60;
const MAX_COOKIE_TTL_SECONDS = 30 * 60;

const DEFAULT_TARGET_ORIGIN =
  "http://workflow-builder.workflow-builder.svc.cluster.local:3000";

type AssertionPayload = WorkflowTargetAuthAssertionClaims & {
  v: 1;
  aud: typeof ASSERTION_AUDIENCE;
  purpose: typeof ASSERTION_PURPOSE;
  iat: number;
  exp: number;
};

type AssertionAdapterOptions = Readonly<{
  secret?: () => string;
  now?: () => Date;
  ttlSeconds?: number;
}>;

function configuredAssertionSecret(): string {
  const secret = (
    env.WORKFLOW_BROWSER_TARGET_AUTH_SIGNING_SECRET ??
    process.env.WORKFLOW_BROWSER_TARGET_AUTH_SIGNING_SECRET ??
    env.WORKFLOW_MCP_SIGNING_SECRET ??
    process.env.WORKFLOW_MCP_SIGNING_SECRET ??
    env.JWT_SIGNING_KEY ??
    process.env.JWT_SIGNING_KEY ??
    ""
  ).trim();
  if (secret.length < 32) {
    throw new Error(
      "browser target-auth signing secret must contain at least 32 characters",
    );
  }
  return secret;
}

function assertionSigningKey(rootSecret: string): Buffer {
  return createHmac("sha256", rootSecret)
    .update(ASSERTION_SIGNING_KEY_CONTEXT, "utf8")
    .digest();
}

function assertionSignature(
  rootSecret: string,
  encodedPayload: string,
): Buffer {
  return createHmac("sha256", assertionSigningKey(rootSecret))
    .update(`${ASSERTION_PREFIX}.${encodedPayload}`, "utf8")
    .digest();
}

function validClaimsShape(
  payload: Partial<AssertionPayload>,
  nowSeconds: number,
): payload is AssertionPayload {
  return (
    payload.v === 1 &&
    payload.aud === ASSERTION_AUDIENCE &&
    payload.purpose === ASSERTION_PURPOSE &&
    typeof payload.executionId === "string" &&
    payload.executionId.length > 0 &&
    typeof payload.userId === "string" &&
    payload.userId.length > 0 &&
    typeof payload.projectId === "string" &&
    payload.projectId.length > 0 &&
    Number.isInteger(payload.tokenVersion) &&
    payload.tokenVersion! >= 0 &&
    Number.isInteger(payload.iat) &&
    Number.isInteger(payload.exp) &&
    payload.iat! <= nowSeconds + MAX_CLOCK_SKEW_SECONDS &&
    payload.exp! > nowSeconds &&
    payload.exp! > payload.iat! &&
    payload.exp! - payload.iat! <= MAX_ASSERTION_TTL_SECONDS
  );
}

export class HmacWorkflowTargetAuthAssertionAdapter implements WorkflowTargetAuthAssertionPort {
  private readonly secret: () => string;
  private readonly now: () => Date;
  private readonly ttlSeconds: number;

  constructor(options: AssertionAdapterOptions = {}) {
    this.secret = options.secret ?? configuredAssertionSecret;
    this.now = options.now ?? (() => new Date());
    this.ttlSeconds = Math.min(
      MAX_ASSERTION_TTL_SECONDS,
      Math.max(60, options.ttlSeconds ?? DEFAULT_ASSERTION_TTL_SECONDS),
    );
  }

  issue(claims: WorkflowTargetAuthAssertionClaims): string {
    if (
      !claims.executionId ||
      !claims.userId ||
      !claims.projectId ||
      !Number.isInteger(claims.tokenVersion) ||
      claims.tokenVersion < 0
    ) {
      throw new Error("browser target-auth assertion scope is incomplete");
    }
    const issuedAt = Math.floor(this.now().getTime() / 1_000);
    const payload: AssertionPayload = {
      v: 1,
      aud: ASSERTION_AUDIENCE,
      purpose: ASSERTION_PURPOSE,
      executionId: claims.executionId,
      userId: claims.userId,
      projectId: claims.projectId,
      tokenVersion: claims.tokenVersion,
      iat: issuedAt,
      exp: issuedAt + this.ttlSeconds,
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
      "base64url",
    );
    return `${ASSERTION_PREFIX}.${encoded}.${assertionSignature(
      this.secret(),
      encoded,
    ).toString("base64url")}`;
  }

  verify(assertion: string): WorkflowTargetAuthAssertionClaims | null {
    try {
      if (
        !assertion ||
        Buffer.byteLength(assertion, "utf8") > MAX_ASSERTION_BYTES
      ) {
        return null;
      }
      const [prefix, encoded, suppliedSignature, extra] = assertion.split(".");
      if (
        prefix !== ASSERTION_PREFIX ||
        !encoded ||
        !suppliedSignature ||
        extra !== undefined
      ) {
        return null;
      }
      const expected = assertionSignature(this.secret(), encoded);
      const supplied = Buffer.from(suppliedSignature, "base64url");
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      ) {
        return null;
      }
      const payload = JSON.parse(
        Buffer.from(encoded, "base64url").toString("utf8"),
      ) as Partial<AssertionPayload>;
      const nowSeconds = Math.floor(this.now().getTime() / 1_000);
      if (!validClaimsShape(payload, nowSeconds)) return null;
      return {
        executionId: payload.executionId,
        userId: payload.userId,
        projectId: payload.projectId,
        tokenVersion: payload.tokenVersion,
      };
    } catch {
      return null;
    }
  }
}

export class HmacWorkflowTargetAuthBindingAdapter implements WorkflowTargetAuthBindingPort {
  constructor(
    private readonly secret: () => string = configuredAssertionSecret,
  ) {}

  derive(scope: WorkflowTargetAuthAssertionClaims): string {
    if (
      !scope.executionId ||
      !scope.userId ||
      !scope.projectId ||
      !Number.isInteger(scope.tokenVersion) ||
      scope.tokenVersion < 0
    ) {
      throw new Error("browser target-auth binding scope is incomplete");
    }
    const key = createHmac("sha256", this.secret())
      .update(AUTHORIZATION_BINDING_KEY_CONTEXT, "utf8")
      .digest();
    const canonicalScope = JSON.stringify([
      scope.executionId,
      scope.userId,
      scope.projectId,
      scope.tokenVersion,
    ]);
    const binding = createHmac("sha256", key)
      .update(canonicalScope, "utf8")
      .digest("base64url");
    return `${AUTHORIZATION_BINDING_PREFIX}.${binding}`;
  }
}

export class PostgresWorkflowTargetAuthIdentityRepository implements WorkflowTargetAuthIdentityRepository {
  constructor(
    private readonly database: ReturnType<
      typeof requirePostgresDb
    > = requirePostgresDb(),
  ) {}

  async resolveExecutionOwner(
    executionId: string,
  ): Promise<WorkflowTargetAuthIdentity | null> {
    const [row] = await this.database
      .select({
        userId: workflowExecutions.userId,
        email: users.email,
        platformId: users.platformId,
        projectId: sql<
          string | null
        >`coalesce(${workflowExecutions.projectId}, ${workflows.projectId})`,
        tokenVersion: userIdentities.tokenVersion,
        executionStatus: workflowExecutions.status,
        executionCompletedAt: workflowExecutions.completedAt,
        executionStopRequestedAt: workflowExecutions.stopRequestedAt,
        userStatus: users.status,
        projectMembershipId: projectMembers.id,
      })
      .from(workflowExecutions)
      .innerJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
      .innerJoin(users, eq(users.id, workflowExecutions.userId))
      .innerJoin(userIdentities, eq(userIdentities.userId, users.id))
      .innerJoin(
        projectMembers,
        and(
          eq(projectMembers.userId, workflowExecutions.userId),
          eq(
            projectMembers.projectId,
            sql<string>`coalesce(${workflowExecutions.projectId}, ${workflows.projectId})`,
          ),
        ),
      )
      .where(
        and(
          eq(workflowExecutions.id, executionId),
          eq(workflowExecutions.status, "running"),
          isNull(workflowExecutions.completedAt),
          isNull(workflowExecutions.stopRequestedAt),
          eq(users.status, "ACTIVE"),
        ),
      )
      .limit(1);

    if (
      !row?.email ||
      !row.platformId ||
      !row.projectId ||
      row.executionStatus !== "running" ||
      row.executionCompletedAt !== null ||
      row.executionStopRequestedAt !== null ||
      row.userStatus !== "ACTIVE" ||
      !row.projectMembershipId
    ) {
      return null;
    }
    return {
      userId: row.userId,
      email: row.email,
      platformId: row.platformId,
      projectId: row.projectId,
      tokenVersion: row.tokenVersion,
      executionStatus: row.executionStatus,
      executionCompletedAt: row.executionCompletedAt,
      executionStopRequestedAt: row.executionStopRequestedAt,
      userStatus: row.userStatus,
      projectMembershipId: row.projectMembershipId,
    };
  }
}

type CookieIssuerOptions = Readonly<{
  now?: () => Date;
  generate?: typeof generateAccessToken;
  ttlSeconds?: number;
}>;

function configuredCookieTtlSeconds(): number {
  const configured = Number(
    env.WORKFLOW_BROWSER_TARGET_ACCESS_TOKEN_TTL_SECONDS ??
      process.env.WORKFLOW_BROWSER_TARGET_ACCESS_TOKEN_TTL_SECONDS,
  );
  if (!Number.isFinite(configured)) return DEFAULT_COOKIE_TTL_SECONDS;
  return Math.min(
    MAX_COOKIE_TTL_SECONDS,
    Math.max(MIN_COOKIE_TTL_SECONDS, Math.trunc(configured)),
  );
}

export class JwtWorkflowTargetAuthCookieIssuer implements WorkflowTargetAuthCookieIssuer {
  private readonly now: () => Date;
  private readonly generate: typeof generateAccessToken;
  private readonly ttlSeconds: number;

  constructor(options: CookieIssuerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.generate = options.generate ?? generateAccessToken;
    this.ttlSeconds = Math.min(
      MAX_COOKIE_TTL_SECONDS,
      Math.max(
        MIN_COOKIE_TTL_SECONDS,
        options.ttlSeconds ?? configuredCookieTtlSeconds(),
      ),
    );
  }

  async issue(
    identity: WorkflowTargetAuthIdentity,
    options: Readonly<{ secure: boolean }>,
  ): Promise<WorkflowTargetAuthCookie> {
    const value = await this.generate(
      {
        sub: identity.userId,
        email: identity.email,
        platformId: identity.platformId,
        projectId: identity.projectId,
        tokenVersion: identity.tokenVersion,
      },
      `${this.ttlSeconds}s`,
    );
    return {
      name: "wb_access_token",
      value,
      expiresAt: Math.floor(this.now().getTime() / 1_000) + this.ttlSeconds,
      httpOnly: true,
      secure: options.secure,
      sameSite: "Strict",
      path: "/",
    };
  }
}

function normalizeTargetOrigin(raw: string): string {
  const parsed = new URL(raw);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("browser target origin must be an HTTP(S) origin");
  }
  return parsed.origin;
}

export class EnvironmentWorkflowTargetAuthOriginProvider implements WorkflowTargetAuthOriginProvider {
  constructor(
    private readonly configuredOrigin: () => string = () =>
      (
        env.WORKFLOW_BROWSER_TARGET_ORIGIN ??
        process.env.WORKFLOW_BROWSER_TARGET_ORIGIN ??
        DEFAULT_TARGET_ORIGIN
      ).trim(),
  ) {}

  getOrigin(): string {
    return normalizeTargetOrigin(this.configuredOrigin());
  }
}

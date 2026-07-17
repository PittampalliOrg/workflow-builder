import { eq, sql } from "drizzle-orm";
import { env } from "$env/dynamic/private";
import {
  userIdentities,
  users,
  workflowExecutions,
  workflows,
} from "$lib/server/db/schema";
import { requirePostgresDb } from "$lib/server/application/adapters/postgres";
import type {
  WorkflowTargetAuthAccessTokenIssuer,
  WorkflowTargetAuthIdentity,
  WorkflowTargetAuthIdentityRepository,
} from "$lib/server/application/workflow-target-auth";
import { generateAccessToken } from "$lib/server/auth-jwt";

const MIN_BROWSER_TARGET_ACCESS_TOKEN_TTL_SECONDS = 2 * 60 * 60;
const DEFAULT_BROWSER_TARGET_ACCESS_TOKEN_TTL_SECONDS = 3 * 60 * 60;
const MAX_BROWSER_TARGET_ACCESS_TOKEN_TTL_SECONDS = 4 * 60 * 60;

function browserTargetAccessTokenTtlSeconds(): number {
  const configured = Number(
    env.WORKFLOW_BROWSER_TARGET_ACCESS_TOKEN_TTL_SECONDS ??
      process.env.WORKFLOW_BROWSER_TARGET_ACCESS_TOKEN_TTL_SECONDS,
  );
  if (!Number.isFinite(configured)) {
    return DEFAULT_BROWSER_TARGET_ACCESS_TOKEN_TTL_SECONDS;
  }
  return Math.min(
    MAX_BROWSER_TARGET_ACCESS_TOKEN_TTL_SECONDS,
    Math.max(
      MIN_BROWSER_TARGET_ACCESS_TOKEN_TTL_SECONDS,
      Math.trunc(configured),
    ),
  );
}

export class PostgresWorkflowTargetAuthIdentityRepository implements WorkflowTargetAuthIdentityRepository {
  async resolveExecutionOwner(
    executionId: string,
  ): Promise<WorkflowTargetAuthIdentity | null> {
    const [row] = await requirePostgresDb()
      .select({
        userId: workflowExecutions.userId,
        email: users.email,
        platformId: users.platformId,
        projectId: sql<
          string | null
        >`coalesce(${workflowExecutions.projectId}, ${workflows.projectId})`,
        tokenVersion: userIdentities.tokenVersion,
      })
      .from(workflowExecutions)
      .innerJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
      .innerJoin(users, eq(users.id, workflowExecutions.userId))
      .innerJoin(userIdentities, eq(userIdentities.userId, users.id))
      .where(eq(workflowExecutions.id, executionId))
      .limit(1);

    if (!row?.email || !row.platformId || !row.projectId) return null;
    return {
      userId: row.userId,
      email: row.email,
      platformId: row.platformId,
      projectId: row.projectId,
      tokenVersion: row.tokenVersion,
    };
  }
}

export class JwtWorkflowTargetAuthAccessTokenIssuer implements WorkflowTargetAuthAccessTokenIssuer {
  issue(identity: WorkflowTargetAuthIdentity): Promise<string> {
    return generateAccessToken(
      {
        sub: identity.userId,
        email: identity.email,
        platformId: identity.platformId,
        projectId: identity.projectId,
        tokenVersion: identity.tokenVersion,
      },
      browserTargetAccessTokenTtlSeconds(),
    );
  }
}

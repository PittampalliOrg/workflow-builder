/**
 * GET /api/workflows/executions/[executionId]/workspace-content?path=<rel>
 *
 * Read one file from a CLI run's shared JuiceFS workspace via juicefs-webdav.
 * Path is relative to the instance root; traversal is rejected by the helper.
 *
 * Workspace-scoped via `assertInScope`.
 */

import { error } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import type { RequestHandler } from "./$types";
import { db } from "$lib/server/db";
import { workflowExecutions } from "$lib/server/db/schema";
import { assertInScope } from "$lib/server/workflows/project-scope";
import { readWorkspaceFile } from "$lib/server/workflows/juicefs-webdav";

export const GET: RequestHandler = async ({ params, url, locals }) => {
  if (!db) return error(503, "Database not configured");
  if (!locals.session?.userId) return error(401, "Authentication required");
  const { executionId } = params;
  if (!executionId) return error(400, "executionId required");

  const relPath = url.searchParams.get("path");
  if (!relPath) return error(400, "path required");

  const [exec] = await db
    .select({
      id: workflowExecutions.id,
      projectId: workflowExecutions.projectId,
      userId: workflowExecutions.userId,
      daprInstanceId: workflowExecutions.daprInstanceId,
    })
    .from(workflowExecutions)
    .where(eq(workflowExecutions.id, executionId))
    .limit(1);
  assertInScope(exec, locals.session, "Execution not found");

  if (!exec.daprInstanceId) return error(404, "Run has no workspace");

  const file = await readWorkspaceFile(exec.daprInstanceId, relPath);
  if (!file) return error(404, "File not found");

  return new Response(new Uint8Array(file.bytes), {
    headers: {
      "Content-Type": file.contentType,
      "Cache-Control": "no-store",
    },
  });
};

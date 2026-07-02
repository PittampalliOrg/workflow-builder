/**
 * GET /api/workflows/executions/[executionId]/workspace-files
 *
 * Recursive listing of a CLI run's shared JuiceFS workspace
 * (/<daprInstanceId>/...) via the in-cluster juicefs-webdav gateway. Durable —
 * works during the run AND after the per-session pod is reaped. Returns paths
 * relative to the instance root for the Files tree to render.
 *
 * Workspace-scoped via `assertInScope`. Reads are confined to this execution's
 * instance subtree by the webdav helper.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { assertInScope } from "$lib/server/workflows/project-scope";
import { listWorkspaceTree } from "$lib/server/workflows/juicefs-webdav";

export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.session?.userId) return error(401, "Authentication required");
  const { executionId } = params;
  if (!executionId) return error(400, "executionId required");

  const exec = await getApplicationAdapters().workflowData.getExecutionById(executionId);
  assertInScope(exec, locals.session, "Execution not found");

  if (!exec.daprInstanceId) return json({ entries: [], truncated: false });

  try {
    const { entries, truncated } = await listWorkspaceTree(exec.daprInstanceId);
    return json({ entries, truncated });
  } catch (err) {
    console.error("[workspace-files] webdav error:", err);
    return json({ entries: [], truncated: false, error: "workspace unavailable" });
  }
};

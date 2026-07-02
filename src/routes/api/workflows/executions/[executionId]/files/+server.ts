/**
 * GET /api/workflows/executions/[executionId]/files
 *
 * Persisted output files for a run, for the run-detail "Files" tab. Resolves
 * the execution's sessions and returns the durable `files` rows scoped to them
 * (purpose='output') — these survive the per-session pod being reaped. Also
 * returns a `liveSandbox` candidate (a non-terminal session's sandbox name) so
 * the UI can offer the LIVE workspace tree (via SandboxFileBrowser) while the
 * pod is still up, falling back to the persisted list otherwise.
 *
 * Workspace-scoped via `assertInScope`. Cross-workspace access 404s.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { assertInScope } from "$lib/server/workflows/project-scope";

export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.session?.userId) return error(401, "Authentication required");

  const { executionId } = params;
  if (!executionId) return error(400, "executionId required");

  // Workspace-scope check via the parent execution row.
  const workflowData = getApplicationAdapters().workflowData;
  const execution = await workflowData.getExecutionById(executionId);
  assertInScope(execution, locals.session, "Execution not found");

  return json(await workflowData.listExecutionOutputFiles(executionId));
};

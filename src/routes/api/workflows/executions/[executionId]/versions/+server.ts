/**
 * GET /api/workflows/executions/[executionId]/versions
 *
 * Per-run "Code versions" list: every `source-bundle` artifact this execution
 * produced (the durable, promotable code versions — see
 * docs/code-version-persistence.md). For dev-pod-as-source GAN runs this is one
 * `tier:"tar-overlay"` version per loop iteration (the deterministic id includes
 * `iteration`); for `/sandbox/work` runs it's the session-end git bundle. Each
 * row pairs with `…/versions/[artifactId]/promote` for the manual Promote → PR.
 * Workspace-scoped.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.session?.userId) return error(401, "Authentication required");
  const { executionId } = params;
  if (!executionId) return error(400, "executionId required");

  const result =
    await getApplicationAdapters().workflowCodeVersions.listVersions({
      executionId,
      userId: locals.session.userId,
      projectId: locals.session.projectId ?? null,
    });
  if (result.status === "error")
    return error(result.httpStatus, result.message);
  return json(result.body);
};

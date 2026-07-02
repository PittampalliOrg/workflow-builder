/**
 * GET /api/workflows/executions/[executionId]/artifacts/[artifactId]/diff
 *
 * Resolves the full unified-diff patch for a `diff` artifact — inline when
 * small, or gunzipped from the offloaded `files` blob when large. Lazy: the run
 * page only fetches this when the user opens the Changes view.
 *
 * Workspace-scoped via `assertInScope`.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { assertInScope } from "$lib/server/workflows/project-scope";
import { resolveRunDiffPatch, RUN_DIFF_KIND } from "$lib/server/workflows/run-diff";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");

	const { executionId, artifactId } = params;
	if (!executionId || !artifactId) return error(400, "executionId and artifactId required");

	const workflowData = getApplicationAdapters().workflowData;
	const exec = await workflowData.getExecutionById(executionId);
	assertInScope(exec, locals.session, "Execution not found");

	const artifact = await workflowData.getWorkflowArtifactForExecution({ executionId, artifactId });
	if (!artifact || artifact.kind !== RUN_DIFF_KIND) {
		return error(404, "Diff artifact not found");
	}

	const resolved = await resolveRunDiffPatch(artifact, {
		getFileContent: workflowData.getWorkflowFileContent.bind(workflowData),
	});
	if (!resolved) return error(404, "Diff artifact not found");

	return json(resolved);
};

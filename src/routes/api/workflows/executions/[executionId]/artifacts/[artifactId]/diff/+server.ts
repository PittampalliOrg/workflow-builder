/**
 * GET /api/workflows/executions/[executionId]/artifacts/[artifactId]/diff
 *
 * Resolves the full unified-diff patch for a `diff` artifact — inline when
 * small, or gunzipped from the offloaded `files` blob when large. Lazy: the run
 * page only fetches this when the user opens the Changes view.
 *
 * Workspace-scoped through the application service.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");

	const { executionId, artifactId } = params;
	if (!executionId || !artifactId) return error(400, "executionId and artifactId required");

	const result = await getApplicationAdapters().workflowExecutionArtifactDiff.getDiff({
		executionId,
		artifactId,
		userId: locals.session.userId,
		projectId: locals.session.projectId,
	});
	if (result.status === "error") {
		return error(result.httpStatus, result.message);
	}

	return json(result.body);
};

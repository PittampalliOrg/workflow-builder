/**
 * GET /api/workflows/executions/[executionId]/artifacts
 *
 * User-facing read API for the run-detail UI. Returns the list of all
 * artifacts persisted for an execution, ordered by slot priority then
 * creation time. The `inlinePayload` of each artifact is included
 * directly so the renderer can display it without extra round-trips.
 *
 * Workspace-scoped through the application service. Cross-workspace access 404s.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");

	const { executionId } = params;
	if (!executionId) return error(400, "executionId required");

	const result = await getApplicationAdapters().workflowExecutionArtifacts.listArtifacts({
		executionId,
		userId: locals.session.userId,
		projectId: locals.session.projectId,
	});
	if (result.status === "error") {
		return error(result.httpStatus, result.message);
	}
	return json(result.body);
};

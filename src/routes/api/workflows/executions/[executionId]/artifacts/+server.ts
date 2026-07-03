/**
 * GET /api/workflows/executions/[executionId]/artifacts
 *
 * User-facing read API for the run-detail UI. Returns the list of all
 * artifacts persisted for an execution, ordered by slot priority then
 * creation time. The `inlinePayload` of each artifact is included
 * directly so the renderer can display it without extra round-trips.
 *
 * Workspace-scoped via `assertInScope`. Cross-workspace access 404s.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");

	const { executionId } = params;
	if (!executionId) return error(400, "executionId required");

	const workflowData = getApplicationAdapters().workflowData;
	let execution;
	try {
		execution = await workflowData.getScopedExecutionById({
			executionId,
			userId: locals.session.userId,
			projectId: locals.session.projectId,
		});
	} catch (err) {
		console.error("[WorkflowArtifacts] execution lookup failed:", err);
		return error(
			503,
			err instanceof Error ? err.message : "Execution lookup failed",
		);
	}

	if (!execution) return error(404, "Execution not found");

	let artifacts;
	try {
		artifacts = await workflowData.listWorkflowArtifactsByExecutionId(executionId);
	} catch (err) {
		console.error("[WorkflowArtifacts] artifact list failed:", err);
		return error(
			503,
			err instanceof Error ? err.message : "Artifact lookup failed",
		);
	}

	return json({ artifacts });
};

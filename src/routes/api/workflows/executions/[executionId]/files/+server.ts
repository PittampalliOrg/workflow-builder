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
 * Workspace-scoped by the application service. Cross-workspace access 404s.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");

	const { executionId } = params;
	if (!executionId) return error(400, "executionId required");

	const result =
		await getApplicationAdapters().workflowExecutionFiles.listOutputFiles({
			executionId,
			userId: locals.session.userId,
			projectId: locals.session.projectId ?? null,
		});
	if (result.status === "error")
		return error(result.httpStatus, result.message);
	return json(result.body);
};

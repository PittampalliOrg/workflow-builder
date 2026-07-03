/**
 * GET /api/workflows/executions/[executionId]/workspace-files
 *
 * Recursive listing of a CLI run's shared durable workspace. Works during the
 * run AND after the per-session pod is reaped. Returns paths relative to the
 * instance root for the Files tree to render.
 *
 * Workspace-scoped by the application service. Reads are confined to this
 * execution's instance subtree by the workspace adapter.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const { executionId } = params;
	if (!executionId) return error(400, "executionId required");

	const result =
		await getApplicationAdapters().workflowExecutionWorkspace.listWorkspaceFiles(
			{
				executionId,
				userId: locals.session.userId,
				projectId: locals.session.projectId ?? null,
			},
		);
	if (result.status === "error")
		return error(result.httpStatus, result.message);
	return json(result.body);
};

import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { guardInternalExecutionAccess } from "../guard";

/**
 * GET /api/internal/executions/[id]/versions
 *
 * Workspace-scoped mirror of the session-authed source-bundle versions list
 * for the Workflow MCP `promote_run_to_pr` tool (internal token + signed
 * principal, workflow:read). Returns the promotable code versions plus
 * unpromotedCount so the tool can pick the latest unpromoted version.
 */
export const GET: RequestHandler = async ({ params, request }) => {
	const guard = await guardInternalExecutionAccess(request, params.id, "workflow:read");
	if (!guard.ok) return guard.res;

	const result =
		await getApplicationAdapters().workflowCodeVersions.listVersions({
			executionId: guard.execution.id,
			userId: guard.execution.userId,
			projectId: guard.execution.projectId,
		});
	if (result.status === "error") {
		return json({ error: result.message }, { status: result.httpStatus });
	}
	return json(result.body);
};

import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { guardInternalExecutionAccess } from "../../../guard";

/**
 * POST /api/internal/executions/[id]/versions/[artifactId]/promote
 *
 * Workspace-scoped mirror of the session-authed promote route for the Workflow
 * MCP `promote_run_to_pr` tool (internal token + signed principal,
 * workflow:execute). Opens a real GitHub PR (or pushes a branch) from the
 * chosen source-bundle version via the promotion helper.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const guard = await guardInternalExecutionAccess(request, params.id, "workflow:execute");
	if (!guard.ok) return guard.res;

	const result =
		await getApplicationAdapters().workflowCodeVersionPromotion.promote({
			executionId: guard.execution.id,
			artifactId: params.artifactId,
			userId: guard.execution.userId,
			projectId: guard.execution.projectId,
			body: await request.json().catch(() => ({})),
		});
	if (result.status === "error") {
		return json({ error: result.message }, { status: result.httpStatus });
	}
	return json(result.body, { status: result.httpStatus ?? 200 });
};

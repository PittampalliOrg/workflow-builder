import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { guardInternalExecutionAccess } from "../guard";

/**
 * GET /api/internal/executions/[id]/code-checkpoints
 *
 * Workspace-scoped mirror of the session-authed
 * /api/workflows/executions/[executionId]/code-checkpoints list, reachable by
 * the Workflow MCP server (internal token + signed principal, workflow:read).
 * Backs the `list_code_checkpoints` MCP tool.
 */
export const GET: RequestHandler = async ({ params, request }) => {
	const guard = await guardInternalExecutionAccess(request, params.id, "workflow:read");
	if (!guard.ok) return guard.res;

	const checkpoints =
		await getApplicationAdapters().workflowCodeCheckpoints.listForExecution({
			executionId: guard.execution.id,
		});
	return json({ checkpoints });
};

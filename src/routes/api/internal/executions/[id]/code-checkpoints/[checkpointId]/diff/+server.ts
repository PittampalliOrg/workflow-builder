import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { guardInternalExecutionAccess } from "../../../guard";

/**
 * GET /api/internal/executions/[id]/code-checkpoints/[checkpointId]/diff?path=
 *
 * Workspace-scoped mirror of the session-authed checkpoint diff route for the
 * Workflow MCP `get_checkpoint_diff` tool (internal token + signed principal,
 * workflow:read).
 */
export const GET: RequestHandler = async ({ params, request, url }) => {
	const guard = await guardInternalExecutionAccess(request, params.id, "workflow:read");
	if (!guard.ok) return guard.res;

	const result =
		await getApplicationAdapters().workflowCodeCheckpoints.diffCheckpoint({
			executionId: guard.execution.id,
			checkpointId: params.checkpointId,
			path: url.searchParams.get("path"),
		});
	if ("status" in result && "error" in result) {
		const status = typeof result.status === "number" ? result.status : 500;
		return json(
			{ error: result.error ?? "Failed to load code checkpoint diff" },
			{ status },
		);
	}
	return json(result);
};

import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { guardInternalExecutionAccess } from "../../../guard";

/**
 * POST /api/internal/executions/[id]/code-checkpoints/[checkpointId]/restore
 *
 * Workspace-scoped mirror of the session-authed checkpoint restore route for
 * the Workflow MCP `restore_checkpoint` tool (internal token + signed
 * principal, workflow:execute). Hard-resets a live sandbox's workspace to the
 * checkpoint's durably-pushed commit.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const guard = await guardInternalExecutionAccess(request, params.id, "workflow:execute");
	if (!guard.ok) return guard.res;

	const body = (await request.json().catch(() => ({}))) as {
		sandboxName?: unknown;
		repoPath?: unknown;
	};
	const result =
		await getApplicationAdapters().workflowCodeCheckpoints.restoreCheckpoint({
			executionId: guard.execution.id,
			checkpointId: params.checkpointId,
			sandboxName: typeof body.sandboxName === "string" ? body.sandboxName : "",
			repoPath: typeof body.repoPath === "string" ? body.repoPath : null,
		});
	if ("status" in result && "error" in result) {
		const status = typeof result.status === "number" ? result.status : 500;
		return json(
			{ error: result.error ?? "Failed to restore code checkpoint" },
			{ status },
		);
	}
	return json(result);
};

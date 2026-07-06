/**
 * GET /api/workflows/executions/[executionId]/script-calls
 *
 * User-facing read API for the dynamic-script run panel. Returns the journal
 * (agent()/workflow() calls) for the execution. Workspace-scoped: a
 * cross-workspace execution 404s (same scope check as the sibling execution
 * routes).
 *
 * Returns { scriptCalls: ScriptCallRecord[] }.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const { executionId } = params;
	if (!executionId) return error(400, "executionId required");

	const result = await getApplicationAdapters().scriptCalls.listForUser({
		executionId,
		userId: locals.session.userId,
		projectId: locals.session.projectId ?? null,
	});
	if (result.status === "error") {
		return error(result.httpStatus, result.message);
	}
	return json(result.body);
};

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { validateInternalToken } from '$lib/server/internal-auth';
import { respondToMcpRun } from '$lib/server/db/mcp';

/**
 * POST /api/internal/mcp/runs/[runId]/respond
 *
 * Stores the final response for an MCP run. Called by the workflow orchestrator
 * (via a Reply/respond activity) when the workflow produces a result for the
 * MCP gateway to return to the external AI client.
 *
 * Security: Validated via X-Internal-Token header.
 */
export const POST: RequestHandler = async ({ request, params }) => {
	if (!validateInternalToken(request)) {
		return error(401, 'Unauthorized');
	}

	const { runId } = params;
	const body = await request.json().catch(() => ({}));

	const updated = await respondToMcpRun({ runId, response: body?.response });
	if (!updated) {
		return error(404, 'Not found');
	}

	return json({ success: true });
};

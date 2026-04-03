import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { validateInternalToken } from '$lib/server/internal-auth';
import { getMcpRun } from '$lib/server/db/mcp';

/**
 * GET /api/internal/mcp/runs/[runId]
 *
 * Returns the current status and response (if any) for an MCP run.
 * Polled by mcp-gateway while waiting for a workflow to complete or
 * for a Reply action to supply a response.
 *
 * Security: Validated via X-Internal-Token header.
 */
export const GET: RequestHandler = async ({ request, params }) => {
	if (!validateInternalToken(request)) {
		return error(401, 'Unauthorized');
	}

	const { runId } = params;
	const run = await getMcpRun(runId);
	if (!run) {
		return error(404, 'Not found');
	}

	return json(run);
};

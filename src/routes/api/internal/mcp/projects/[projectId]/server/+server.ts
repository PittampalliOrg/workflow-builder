import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { validateInternalToken } from '$lib/server/internal-auth';
import { getApplicationAdapters } from '$lib/server/application';

/**
 * GET /api/internal/mcp/projects/[projectId]/server
 *
 * Returns the MCP server config including decrypted token and tool/flow definitions.
 * Called by mcp-gateway to bootstrap its tool registry for a project.
 *
 * Security: Validated via X-Internal-Token header.
 */
export const GET: RequestHandler = async ({ request, params }) => {
	if (!validateInternalToken(request)) {
		return error(401, 'Unauthorized');
	}

	const { projectId } = params;
	const result = await getApplicationAdapters().workflowData.getInternalHostedMcpServer({
		projectId
	});
	if (!result.ok) return error(result.status, result.message);
	return json(result.server);
};

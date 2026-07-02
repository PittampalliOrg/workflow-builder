import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

/**
 * POST /api/v1/projects/[projectId]/mcp-server/rotate
 *
 * Rotate the MCP server authentication token.
 * Requires ADMIN or EDITOR role on the project.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');

	const { workflowData } = getApplicationAdapters();
	const result = await workflowData.rotateProjectHostedMcpServerToken({
		projectId: params.projectId,
		userId: locals.session.userId,
		requestUrl: request.url
	});
	if (!result.ok) return error(result.status, result.message);
	return json(result.server);
};

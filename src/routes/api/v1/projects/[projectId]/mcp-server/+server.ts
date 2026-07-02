import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

/**
 * GET /api/v1/projects/[projectId]/mcp-server
 *
 * Returns the populated MCP server config (token, status, MCP-triggered workflows).
 * Also syncs the hosted workflow MCP connection row.
 */
export const GET: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');

	const { workflowData } = getApplicationAdapters();
	const result = await workflowData.getProjectHostedMcpServer({
		projectId: params.projectId,
		userId: locals.session.userId,
		requestUrl: request.url
	});
	if (!result.ok) return error(result.status, result.message);
	return json(result.server);
};

/**
 * POST /api/v1/projects/[projectId]/mcp-server
 *
 * Update MCP server status (ENABLED / DISABLED).
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');

	const body = (await request.json().catch(() => null)) as {
		status?: 'ENABLED' | 'DISABLED';
	} | null;

	const { workflowData } = getApplicationAdapters();
	const result = await workflowData.updateProjectHostedMcpServerStatus({
		projectId: params.projectId,
		userId: locals.session.userId,
		status: body?.status,
		requestUrl: request.url
	});
	if (!result.ok) return error(result.status, result.message);
	return json(result.server);
};

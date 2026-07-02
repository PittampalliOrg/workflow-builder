import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { validateInternalToken } from '$lib/server/internal-auth';

/**
 * GET /api/internal/mcp/projects/[projectId]/catalog
 *
 * Returns the enabled project MCP connections in a shape that MCPJam can merge
 * with its shared catalog. The path parameter accepts either the project id or
 * the project's external id.
 *
 * Security: Validated via X-Internal-Token header.
 */
export const GET: RequestHandler = async ({ request, params }) => {
	if (!validateInternalToken(request)) {
		return error(401, 'Unauthorized');
	}
	const result = await getApplicationAdapters().workflowData.getInternalProjectMcpCatalog({
		projectRef: params.projectId
	});
	if (!result.ok) return error(result.status, result.message);
	return json(result.catalog);
};

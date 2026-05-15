import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { getMcpAvailability } from '$lib/server/mcp-availability';
import { requireSessionProjectId } from '$lib/server/mcp-connections';

/**
 * GET /api/mcp-connections/availability
 *
 * Browser-safe MCP availability model for dropdowns and setup flows. The
 * executable piece-backed server list comes from the registered Knative MCP
 * catalog, then joins project MCP rows and app connection auth state.
 */
export const GET: RequestHandler = async ({ locals }) => {
	const projectId = requireSessionProjectId(locals);
	if (!locals.session?.userId) return error(401, 'Unauthorized');
	if (!db) return json({ entries: [], projectConnections: [], customConnections: [] });

	return json(await getMcpAvailability(db, projectId, locals.session.platformId));
};

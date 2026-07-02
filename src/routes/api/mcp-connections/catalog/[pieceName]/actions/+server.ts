import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

function requireProjectId(locals: App.Locals): string {
	const projectId = locals.session?.projectId?.trim();
	if (!locals.session?.userId) throw error(401, 'Unauthorized');
	if (!projectId) throw error(400, 'Current session does not include a project');
	return projectId;
}

/**
 * GET /api/mcp-connections/catalog/[pieceName]/actions
 *
 * Per-piece action (tool) list for the agent Tools & Integrations surface.
 */
export const GET: RequestHandler = async ({ locals, params }) => {
	requireProjectId(locals);

	const result = await getApplicationAdapters().workflowData.getMcpCatalogPieceActions(
		params.pieceName
	);

	if (!result.ok) return error(result.status, result.message);
	return json({ pieceName: result.pieceName, actions: result.actions });
};

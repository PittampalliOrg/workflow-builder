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
 * GET /api/mcp-connections/catalog
 *
 * Browser-safe catalog of predefined piece-backed MCP servers. It includes
 * configured state and connection summaries, but never returns OAuth client
 * secrets or decrypted app/vault credentials.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
	const projectId = requireProjectId(locals);

	return json(
		await getApplicationAdapters().workflowData.getMcpConnectionCatalog({
			projectId,
			platformId: locals.session?.platformId,
			query: url.searchParams.get('q') || url.searchParams.get('search'),
			authOnly: url.searchParams.get('authOnly') === 'true',
			configuredOnly: url.searchParams.get('configuredOnly') === 'true'
		})
	);
};

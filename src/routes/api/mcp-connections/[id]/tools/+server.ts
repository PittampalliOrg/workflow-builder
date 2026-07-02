import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

function requireProjectId(locals: App.Locals): string {
	const projectId = locals.session?.projectId?.trim();
	if (!locals.session?.userId) throw error(401, 'Unauthorized');
	if (!projectId) throw error(400, 'Current session does not include a project');
	return projectId;
}

export const GET: RequestHandler = async ({ params, locals }) => {
	const result = await getApplicationAdapters().workflowData.discoverProjectMcpConnectionTools({
		id: params.id,
		projectId: requireProjectId(locals)
	});

	if (!result.ok) return error(result.status, result.message);
	return json({ toolNames: result.toolNames, source: result.source });
};

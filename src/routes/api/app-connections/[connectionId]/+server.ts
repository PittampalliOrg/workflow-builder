import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

function requireProjectId(locals: App.Locals): string {
	const projectId = locals.session?.projectId?.trim();
	if (!locals.session?.userId) throw error(401, 'Unauthorized');
	if (!projectId) throw error(400, 'Current session does not include a project');
	return projectId;
}

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	const projectId = requireProjectId(locals);
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

	const result = await getApplicationAdapters().workflowData.updateProjectAppConnection({
		id: params.connectionId,
		projectId,
		displayName: body.displayName
	});

	if (!result.ok) return error(result.status, { message: result.message });
	return json(result.connection);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	const projectId = requireProjectId(locals);

	const result = await getApplicationAdapters().workflowData.deleteProjectAppConnection({
		id: params.connectionId,
		projectId
	});

	if (!result.ok) return error(result.status, { message: result.message });
	return json({ success: true });
};

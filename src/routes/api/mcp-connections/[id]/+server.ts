import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

function requireProjectId(locals: App.Locals): string {
	const projectId = locals.session?.projectId?.trim();
	if (!locals.session?.userId) throw error(401, 'Unauthorized');
	if (!projectId) throw error(400, 'Current session does not include a project');
	return projectId;
}

const updateConnection: RequestHandler = async ({ params, request, locals }) => {
	const projectId = requireProjectId(locals);
	const userId = locals.session?.userId;
	if (!userId) return error(401, 'Unauthorized');

	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const result = await getApplicationAdapters().workflowData.updateProjectMcpConnection({
		id: params.id,
		projectId,
		userId,
		status: body.status,
		connectionExternalId: body.connectionExternalId,
		connectionExternalIdProvided: Object.hasOwn(body, 'connectionExternalId'),
		toolSelection: body.toolSelection,
		toolSelectionProvided: Object.hasOwn(body, 'toolSelection')
	});

	if (!result.ok) return error(result.status, result.message);
	return json(result.connection);
};

export const POST: RequestHandler = updateConnection;
export const PATCH: RequestHandler = updateConnection;

export const DELETE: RequestHandler = async ({ params, locals }) => {
	const projectId = requireProjectId(locals);

	const result = await getApplicationAdapters().workflowData.deleteProjectMcpConnection({
		id: params.id,
		projectId
	});

	if (!result.ok) return error(result.status, result.message);
	return json({ success: true });
};

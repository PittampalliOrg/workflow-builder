import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

function requireProjectId(locals: App.Locals): string {
	const projectId = locals.session?.projectId?.trim();
	if (!locals.session?.userId) throw error(401, 'Unauthorized');
	if (!projectId) throw error(400, 'Current session does not include a project');
	return projectId;
}

export const GET: RequestHandler = async ({ locals }) => {
	const projectId = requireProjectId(locals);

	return json(await getApplicationAdapters().workflowData.listProjectMcpConnections(projectId));
};

export const POST: RequestHandler = async ({ request, locals }) => {
	const projectId = requireProjectId(locals);
	const userId = locals.session?.userId;
	if (!userId) return error(401, 'Unauthorized');

	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const result = await getApplicationAdapters().workflowData.createProjectMcpConnection({
		projectId,
		userId,
		sourceType: body.sourceType,
		pieceName: body.pieceName,
		displayName: body.displayName,
		serverUrl: body.serverUrl,
		connectionExternalId: body.connectionExternalId,
		metadata: body.metadata
	});

	if (!result.ok) return error(result.status, result.message);
	return json(result.connection, { status: result.status });
};

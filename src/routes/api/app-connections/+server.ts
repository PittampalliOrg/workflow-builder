import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

function requireProjectId(locals: App.Locals): string {
	const projectId = locals.session?.projectId?.trim();
	if (!locals.session?.userId) throw error(401, 'Unauthorized');
	if (!projectId) throw error(400, 'Current session does not include a project');
	return projectId;
}

export const GET: RequestHandler = async ({ url, locals }) => {
	const projectId = requireProjectId(locals);

	return json(
		await getApplicationAdapters().workflowData.listProjectAppConnections({
			projectId,
			pieceName: url.searchParams.get('pieceName'),
			provider:
				url.searchParams.get('provider') ||
				url.searchParams.get('providerId'),
			search:
				url.searchParams.get('q') ||
				url.searchParams.get('search') ||
				url.searchParams.get('displayName'),
			status: url.searchParams.get('status'),
			type: url.searchParams.get('type'),
			scope: url.searchParams.get('scope')
		})
	);
};

export const POST: RequestHandler = async ({ request, locals }) => {
	const projectId = requireProjectId(locals);
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

	const result = await getApplicationAdapters().workflowData.createProjectAppConnection({
		projectId,
		userId: locals.session?.userId ?? null,
		platformId: locals.session?.platformId ?? null,
		pieceName: body.pieceName,
		displayName: body.displayName,
		type: body.type,
		value: body.value,
		scope: body.scope
	});

	if (!result.ok) return error(result.status, { message: result.message });
	return json(result.connection, { status: 201 });
};

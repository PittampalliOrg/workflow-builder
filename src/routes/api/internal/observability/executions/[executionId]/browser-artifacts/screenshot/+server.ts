import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { guardAnalystAccess } from '../../guard';

const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;

/** Scope-validated browser screenshot payload for vision-capable MCP clients. */
export const GET: RequestHandler = async ({ params, request, url }) => {
	const guard = await guardAnalystAccess(request, params.executionId);
	if (!guard.ok) return guard.res;
	const storageRef = url.searchParams.get('storageRef')?.trim();
	if (!storageRef) return json({ error: 'storageRef is required' }, { status: 400 });

	const result = await getApplicationAdapters().workflowBrowserArtifacts.getScreenshot({
		executionId: guard.execution.id,
		userId: guard.execution.userId,
		projectId: guard.execution.projectId,
		storageRef,
		maxBytes: MAX_SCREENSHOT_BYTES
	});
	if (result.status === 'error') {
		return json({ error: result.message }, { status: result.httpStatus });
	}
	return json(result.body);
};

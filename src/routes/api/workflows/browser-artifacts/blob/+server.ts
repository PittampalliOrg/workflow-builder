import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

const MAX_BROWSER_ASSET_BYTES = 50 * 1024 * 1024;

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.session?.userId) throw error(401, 'Authentication required');
	const executionId = url.searchParams.get('executionId')?.trim();
	if (!executionId) throw error(400, 'executionId is required');
	const storageRef = url.searchParams.get('storageRef')?.trim();
	if (!storageRef) {
		throw error(400, 'storageRef is required');
	}

	const result = await getApplicationAdapters().workflowBrowserArtifacts.getAsset({
		executionId,
		userId: locals.session.userId,
		projectId: locals.session.projectId,
		storageRef,
		maxBytes: MAX_BROWSER_ASSET_BYTES
	});
	if (result.status === 'error') {
		throw error(result.httpStatus, result.message);
	}

	return new Response(Buffer.from(result.body.payloadBase64, 'base64'), {
		headers: {
			'Content-Type': result.body.contentType,
			'Cache-Control': 'private, max-age=300'
		}
	});
};

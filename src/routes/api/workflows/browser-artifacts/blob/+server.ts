import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

export const GET: RequestHandler = async ({ url }) => {
	const storageRef = url.searchParams.get('storageRef')?.trim();
	if (!storageRef) {
		throw error(400, 'storageRef is required');
	}

	const payload = await getApplicationAdapters().workflowData.getWorkflowBrowserBlobPayload(
		storageRef
	);
	if (!payload) {
		throw error(404, 'Blob not found');
	}

	return new Response(Buffer.from(payload.payloadBase64, 'base64'), {
		headers: {
			'Content-Type': payload.contentType,
			'Cache-Control': 'private, max-age=300'
		}
	});
};

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

export const GET: RequestHandler = async ({ params, url }) => {
	try {
		const result = await getApplicationAdapters().workflowCodeCheckpoints.diffCheckpoint({
			executionId: params.executionId,
			checkpointId: params.checkpointId,
			path: url.searchParams.get('path')
		});
		if ('status' in result && 'error' in result) {
			const status = typeof result.status === 'number' ? result.status : 500;
			return json(
				{ message: result.error ?? 'Failed to load code checkpoint diff' },
				{ status }
			);
		}
		return json(result);
	} catch (err) {
		console.error('[code-checkpoints] diff failed:', err);
		return json({ message: 'Failed to load code checkpoint diff' }, { status: 500 });
	}
};

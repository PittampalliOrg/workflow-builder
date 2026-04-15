import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { loadCodeCheckpointDiff } from '$lib/server/workflows/code-checkpoints';

export const GET: RequestHandler = async ({ params, url }) => {
	try {
		const result = await loadCodeCheckpointDiff(
			params.executionId,
			params.checkpointId,
			url.searchParams.get('path')
		);
		if ('status' in result && 'error' in result) {
			const status = typeof result.status === 'number' ? result.status : 500;
			return error(status, result.error ?? 'Failed to load code checkpoint diff');
		}
		return json(result);
	} catch (err) {
		console.error('[code-checkpoints] diff failed:', err);
		return error(500, 'Failed to load code checkpoint diff');
	}
};

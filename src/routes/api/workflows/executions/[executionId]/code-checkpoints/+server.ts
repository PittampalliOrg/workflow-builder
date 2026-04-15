import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listCodeCheckpointsForExecution } from '$lib/server/workflows/code-checkpoints';

export const GET: RequestHandler = async ({ params }) => {
	try {
		const checkpoints = await listCodeCheckpointsForExecution(
			params.executionId
		);
		return json({ checkpoints });
	} catch (err) {
		console.error('[code-checkpoints] list failed:', err);
		return error(500, 'Failed to load code checkpoints');
	}
};

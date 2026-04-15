import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { restoreCodeCheckpointToSandbox } from '$lib/server/workflows/code-checkpoints';

export const POST: RequestHandler = async ({ params, request }) => {
	try {
		const body = (await request.json().catch(() => ({}))) as {
			sandboxName?: unknown;
			repoPath?: unknown;
		};
		const result = await restoreCodeCheckpointToSandbox({
			executionId: params.executionId,
			checkpointId: params.checkpointId,
			sandboxName: typeof body.sandboxName === 'string' ? body.sandboxName : '',
			repoPath: typeof body.repoPath === 'string' ? body.repoPath : null
		});
		if ('status' in result && 'error' in result) {
			const status = typeof result.status === 'number' ? result.status : 500;
			return error(status, result.error ?? 'Failed to restore code checkpoint');
		}
		return json(result);
	} catch (err) {
		console.error('[code-checkpoints] restore failed:', err);
		return error(500, 'Failed to restore code checkpoint');
	}
};

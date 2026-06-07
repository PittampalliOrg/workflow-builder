import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runAgentRunOperation } from '$lib/server/workflow-ops';
import { requirePlatformAdmin } from '$lib/server/platform-admin';

function parseJsonInput(raw: unknown): unknown {
	if (typeof raw !== 'string' || !raw.trim()) return undefined;
	try {
		return JSON.parse(raw);
	} catch {
		throw error(400, { message: 'JSON payload is invalid' });
	}
}

export const POST: RequestHandler = async ({ params, request, locals }) => {
	await requirePlatformAdmin(locals);
	const body = await request.json().catch(() => ({}));
	const result = await runAgentRunOperation(params.agentRunId, params.operation, {
		reason: typeof body.reason === 'string' ? body.reason : undefined,
		fromEventId: Number(body.fromEventId ?? 0),
		newInstanceId: typeof body.newInstanceId === 'string' ? body.newInstanceId : undefined,
		overwriteInput: body.overwriteInput === true,
		input: body.overwriteInput === true ? parseJsonInput(body.inputJson) : undefined,
		codeCheckpointId:
			typeof body.codeCheckpointId === 'string' ? body.codeCheckpointId : undefined,
		restoreMode: body.restoreMode === 'fresh' ? 'fresh' : 'live',
		force: body.force === true,
		recursive: body.recursive === true
	});
	return json(result);
};

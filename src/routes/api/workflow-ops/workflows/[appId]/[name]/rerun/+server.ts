import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { rerunWorkflowInstances } from '$lib/server/workflow-ops';
import { requirePlatformAdmin } from '$lib/server/platform-admin';

function parseJsonInput(raw: unknown): unknown {
	if (typeof raw !== 'string' || !raw.trim()) return undefined;
	try {
		return JSON.parse(raw);
	} catch {
		throw error(400, { message: 'JSON payload is invalid' });
	}
}

export const POST: RequestHandler = async ({ request, locals }) => {
	// Mutating bulk op — match the /api/workflow-ops/* platform-admin invariant
	// (the sibling [operation] route already enforces it).
	await requirePlatformAdmin(locals);
	const body = await request.json().catch(() => ({}));
	const instanceIds = Array.isArray(body.instanceIds)
		? body.instanceIds.filter((value: unknown): value is string => typeof value === 'string' && value.length > 0)
		: [];
	if (!instanceIds.length) throw error(400, { message: 'Select at least one workflow execution to replay' });
	return json(
		await rerunWorkflowInstances(instanceIds, {
			fromEventId: Number(body.fromEventId ?? 0),
			overwriteInput: body.overwriteInput === true,
			input: body.overwriteInput === true ? parseJsonInput(body.inputJson) : undefined,
			reason: typeof body.reason === 'string' ? body.reason : undefined
		})
	);
};

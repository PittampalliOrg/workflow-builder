import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { requirePlatformAdmin } from '$lib/server/platform-admin';
import { deleteWorkflowActorReminders } from '$lib/server/workflow-ops';

export const POST: RequestHandler = async ({ locals, params, request }) => {
	await requirePlatformAdmin(locals);
	const instanceId = params.instanceId;
	if (!instanceId) {
		return json({ message: 'instanceId is required' }, { status: 400 });
	}
	const body = await request.json().catch(() => ({}));
	const result = await deleteWorkflowActorReminders(instanceId, body);
	return json(result);
};

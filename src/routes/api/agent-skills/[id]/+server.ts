import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { deleteCustomSkill, updateCustomSkill } from '$lib/server/agent-skills';

export const PATCH: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');
	if (!locals.session.projectId) return error(400, 'No active workspace');

	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

	try {
		const skill = await updateCustomSkill(
			params.id,
			{
				name: typeof body.name === 'string' ? body.name : undefined,
				description:
					body.description === null
						? null
						: typeof body.description === 'string'
							? body.description
							: undefined,
				whenToUse:
					body.whenToUse === null
						? null
						: typeof body.whenToUse === 'string'
							? body.whenToUse
							: undefined,
				prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
				allowedTools: Array.isArray(body.allowedTools)
					? (body.allowedTools as unknown[]).filter(
							(t): t is string => typeof t === 'string',
						)
					: undefined,
				argumentHint:
					body.argumentHint === null
						? null
						: typeof body.argumentHint === 'string'
							? body.argumentHint
							: undefined,
				model:
					body.model === null
						? null
						: typeof body.model === 'string'
							? body.model
							: undefined,
				status:
					body.status === 'ENABLED' ||
					body.status === 'DISABLED' ||
					body.status === 'DRAFT'
						? body.status
						: undefined
			},
			{
				userId: locals.session.userId,
				projectId: locals.session.projectId
			}
		);
		return json({ skill });
	} catch (err) {
		return error(400, err instanceof Error ? err.message : 'Failed to update skill');
	}
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');
	if (!locals.session.projectId) return error(400, 'No active workspace');

	try {
		const ok = await deleteCustomSkill(params.id, { projectId: locals.session.projectId });
		if (!ok) return error(404, 'Custom skill not found');
		return json({ ok: true });
	} catch (err) {
		return error(400, err instanceof Error ? err.message : 'Failed to delete skill');
	}
};

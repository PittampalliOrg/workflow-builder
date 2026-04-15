import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { canManageAgentSkills, importAgentSkill } from '$lib/server/agent-skills';

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');
	if (!(await canManageAgentSkills(locals.session.userId, locals.session.projectId))) return error(403, 'Forbidden');
	const body = await request.json().catch(() => null);
	if (!body || typeof body !== 'object') return error(400, 'Expected JSON body');
	try {
		const skill = await importAgentSkill(body, locals.session.userId);
		return json({ skill });
	} catch (err) {
		return error(400, err instanceof Error ? err.message : 'Failed to import skill');
	}
};

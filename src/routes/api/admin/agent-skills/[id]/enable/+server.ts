import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { canManageAgentSkills, setAgentSkillStatus } from '$lib/server/agent-skills';

export const POST: RequestHandler = async ({ locals, params }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');
	if (!(await canManageAgentSkills(locals.session.userId))) return error(403, 'Forbidden');
	try {
		const skill = await setAgentSkillStatus(decodeURIComponent(params.id), 'ENABLED');
		return json({ skill });
	} catch (err) {
		return error(404, err instanceof Error ? err.message : 'Skill not found');
	}
};

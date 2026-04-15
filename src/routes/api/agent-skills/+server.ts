import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { canManageAgentSkills, listAgentSkills } from '$lib/server/agent-skills';

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');
	const includeDisabled = url.searchParams.get('includeDisabled') === 'true';
	const skills = await listAgentSkills({ includeDisabled });
	const canManage = await canManageAgentSkills(locals.session.userId, locals.session.projectId);
	return json({ skills, canManage });
};

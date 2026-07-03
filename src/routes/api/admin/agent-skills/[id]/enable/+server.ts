import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { AgentSkillServiceError } from '$lib/server/application/agent-skills';

export const POST: RequestHandler = async ({ locals, params }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');
	try {
		const skill = await getApplicationAdapters().agentSkills.setStatus({
			id: decodeURIComponent(params.id),
			status: 'ENABLED',
			userId: locals.session.userId,
			projectId: locals.session.projectId
		});
		return json({ skill });
	} catch (err) {
		if (err instanceof AgentSkillServiceError) return error(err.status, err.message);
		return error(404, err instanceof Error ? err.message : 'Skill not found');
	}
};

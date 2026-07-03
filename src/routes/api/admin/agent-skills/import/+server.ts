import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { AgentSkillServiceError } from '$lib/server/application/agent-skills';

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');
	const body = await request.json().catch(() => null);
	if (!body || typeof body !== 'object') return error(400, 'Expected JSON body');
	try {
		const skill = await getApplicationAdapters().agentSkills.importRegistrySkill({
			body: body as Record<string, unknown>,
			userId: locals.session.userId,
			projectId: locals.session.projectId
		});
		return json({ skill });
	} catch (err) {
		if (err instanceof AgentSkillServiceError) return error(err.status, err.message);
		return error(400, err instanceof Error ? err.message : 'Failed to import skill');
	}
};

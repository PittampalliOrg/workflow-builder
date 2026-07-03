import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { AgentSkillServiceError } from '$lib/server/application/agent-skills';

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');
	const includeDisabled = url.searchParams.get('includeDisabled') === 'true';
	const result = await getApplicationAdapters().agentSkills.list({
		includeDisabled,
		userId: locals.session.userId,
		projectId: locals.session.projectId
	});
	return json(result);
};

/**
 * POST /api/agent-skills
 *
 * Create a workspace-scoped custom skill. Any member of the active
 * workspace can create; deletes and edits are gated on ownership.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');

	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

	try {
		const skill = await getApplicationAdapters().agentSkills.createCustom({
			body,
			userId: locals.session.userId,
			projectId: locals.session.projectId
		});
		return json({ skill }, { status: 201 });
	} catch (err) {
		if (err instanceof AgentSkillServiceError) return error(err.status, err.message);
		return error(400, err instanceof Error ? err.message : 'Failed to create skill');
	}
};

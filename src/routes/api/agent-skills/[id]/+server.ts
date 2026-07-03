import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { AgentSkillServiceError } from '$lib/server/application/agent-skills';

/**
 * GET /api/agent-skills/[id]
 *
 * Returns one skill visible to the caller — either a global curated row
 * (project_id IS NULL) or a custom row in the caller's active workspace.
 * Match by registryId / id / slug so the detail page can be linked via
 * any of those identifiers.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');
	const match = await getApplicationAdapters().agentSkills.get({
		id: params.id,
		projectId: locals.session.projectId
	});
	if (!match) return error(404, 'Skill not found');
	return json({ skill: match });
};

export const PATCH: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');

	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

	try {
		const skill = await getApplicationAdapters().agentSkills.updateCustom({
			id: params.id,
			body,
			userId: locals.session.userId,
			projectId: locals.session.projectId
		});
		return json({ skill });
	} catch (err) {
		if (err instanceof AgentSkillServiceError) return error(err.status, err.message);
		return error(400, err instanceof Error ? err.message : 'Failed to update skill');
	}
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');

	try {
		const ok = await getApplicationAdapters().agentSkills.deleteCustom({
			id: params.id,
			projectId: locals.session.projectId
		});
		if (!ok) return error(404, 'Custom skill not found');
		return json({ ok: true });
	} catch (err) {
		if (err instanceof AgentSkillServiceError) return error(err.status, err.message);
		return error(400, err instanceof Error ? err.message : 'Failed to delete skill');
	}
};

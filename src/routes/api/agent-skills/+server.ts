import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	canManageAgentSkills,
	createCustomSkill,
	listAgentSkills
} from '$lib/server/agent-skills';

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');
	const includeDisabled = url.searchParams.get('includeDisabled') === 'true';
	const skills = await listAgentSkills({
		includeDisabled,
		projectId: locals.session.projectId
	});
	const canManage = await canManageAgentSkills(locals.session.userId, locals.session.projectId);
	return json({ skills, canManage });
};

/**
 * POST /api/agent-skills
 *
 * Create a workspace-scoped custom skill. Any member of the active
 * workspace can create; deletes and edits are gated on ownership.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');
	if (!locals.session.projectId) return error(400, 'No active workspace');

	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const name = typeof body.name === 'string' ? body.name : '';
	const prompt = typeof body.prompt === 'string' ? body.prompt : '';
	if (!name.trim()) return error(400, 'name is required');
	if (!prompt.trim()) return error(400, 'prompt is required');

	try {
		const skill = await createCustomSkill({
			name,
			slug: typeof body.slug === 'string' ? body.slug : undefined,
			description: typeof body.description === 'string' ? body.description : null,
			whenToUse: typeof body.whenToUse === 'string' ? body.whenToUse : null,
			prompt,
			allowedTools: Array.isArray(body.allowedTools)
				? (body.allowedTools as unknown[]).filter((t): t is string => typeof t === 'string')
				: [],
			argumentHint: typeof body.argumentHint === 'string' ? body.argumentHint : null,
			model: typeof body.model === 'string' ? body.model : null,
			projectId: locals.session.projectId,
			userId: locals.session.userId
		});
		return json({ skill }, { status: 201 });
	} catch (err) {
		return error(400, err instanceof Error ? err.message : 'Failed to create skill');
	}
};

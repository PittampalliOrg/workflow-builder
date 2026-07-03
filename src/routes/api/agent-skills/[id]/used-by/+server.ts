import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

/**
 * GET /api/agent-skills/[id]/used-by
 *
 * Returns the agents (current versions only, not archived) in the caller's
 * workspace + globals that attach this skill. Drives the skills-library
 * page's "Used by N agents" popover so curators can audit before disabling.
 *
 * Looks up the skill by id/registryId/slug then scans
 * `agent_versions.config->'skills'` with PostgreSQL jsonpath. Capped at 50
 * rows; if truncated, sets `truncated: true` in the response.
 */
const MAX_AGENTS = 50;

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');
	try {
		const result = await getApplicationAdapters().workflowData.listAgentSkillUsedBy({
			skillRef: params.id,
			projectId: locals.session.projectId ?? null,
			limit: MAX_AGENTS
		});
		if (!result) return error(404, 'Skill not found');
		return json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : '';
		if (/Database not configured/.test(message)) {
			return error(503, 'Database is not configured');
		}
		throw err;
	}
};

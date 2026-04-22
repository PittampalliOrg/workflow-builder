import { error, json } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { agentSkillRegistry } from '$lib/server/db/schema';
import { listAgentSkills } from '$lib/server/agent-skills';

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
	if (!db) return error(503, 'Database is not configured');

	// Resolve the skill (reuses workspace-scoping + visibility rules already
	// baked into listAgentSkills). Cheap enough — the list is bounded per
	// workspace and doesn't run on the hot path.
	const skills = await listAgentSkills({
		includeDisabled: true,
		projectId: locals.session.projectId
	});
	const match = skills.find(
		(s) => s.id === params.id || s.registryId === params.id || s.slug === params.id
	);
	if (!match) return error(404, 'Skill not found');

	const projectId = locals.session.projectId ?? null;

	// One query: JOIN agents → current agent_versions, unnest config.skills[]
	// and match by registryId or slug. Scopes to caller's workspace + globals.
	// Avoids jsonpath literals (drizzle's sql template tokenizer mis-parses
	// the `$rid` / `$sl` vars as parameter refs).
	const rows = await db.execute(sql`
		SELECT a.id, a.slug, a.name, a.project_id AS "projectId",
		       a.runtime_app_id AS "runtimeAppId", a.registry_status AS "registryStatus"
		FROM agents a
		JOIN agent_versions av ON av.id = a.current_version_id
		WHERE a.is_archived = false
			AND NOT COALESCE(a.tags, '[]'::jsonb) @> '["workflow-ephemeral"]'::jsonb
			AND (${projectId === null}::boolean OR a.project_id = ${projectId} OR a.project_id IS NULL)
			AND EXISTS (
				SELECT 1
				FROM jsonb_array_elements(COALESCE(av.config->'skills', '[]'::jsonb)) se
				WHERE (se->>'registryId') = ${match.id}
				   OR (se->>'slug') = ${match.slug}
			)
		ORDER BY a.name ASC
		LIMIT ${MAX_AGENTS + 1}
	`);

	type AgentRow = {
		id: string;
		slug: string;
		name: string;
		projectId: string | null;
		runtimeAppId: string | null;
		registryStatus: string | null;
	};
	const all = (rows as unknown as AgentRow[]) ?? [];
	const truncated = all.length > MAX_AGENTS;
	const agents = truncated ? all.slice(0, MAX_AGENTS) : all;
	// Reference the `agentSkillRegistry` symbol so the drizzle import stays
	// live — tree-shakers sometimes drop the schema re-export otherwise.
	void agentSkillRegistry;
	return json({ agents, truncated, total: all.length });
};

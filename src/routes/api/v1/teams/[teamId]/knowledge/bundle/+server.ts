import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { renderBundle } from "$lib/server/teams/team-okf";
import type { TeamKnowledgeRow } from "$lib/server/application/ports";

/**
 * GET /api/v1/teams/[teamId]/knowledge/bundle — the team's knowledge as a
 * complete OKF v0.1 bundle: `{ files: [{path, content}] }` with a generated
 * root index.md (okf_version declaration), log.md, and one file per concept.
 * Write the files to a directory (or tar them) and you have a portable,
 * spec-conformant knowledge bundle any OKF consumer can read.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const store = getApplicationAdapters().teamStore;
	const team = await store.getTeam(params.teamId);
	if (!team) return error(404, "no such team");
	const index = await store.listKnowledge(params.teamId);
	const concepts: TeamKnowledgeRow[] = [];
	for (const e of index) {
		const row = await store.getKnowledge(params.teamId, e.path);
		if (row) concepts.push(row);
	}
	return json({
		team: { id: team.id, name: team.name },
		okfVersion: "0.1",
		files: renderBundle(team.name, index, concepts),
	});
};

import { sql } from "drizzle-orm";
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { validateInternalToken } from "$lib/server/internal-auth";
import { getApplicationAdapters } from "$lib/server/application";
import { db } from "$lib/server/db";
import {
	addMember,
	ensureTeam,
	resolveAgentIdBySlug,
	type TeamsDb,
} from "$lib/server/teams/team-repo";
import {
	ensureTeamRunExecution,
	linkSessionToTeamRun,
} from "$lib/server/teams/team-run";

/**
 * POST /api/internal/team/[teamId]/spawn
 *   { leadSessionId, agentSlug, name, prompt, model?, planModeRequired? }
 *
 * Form the team (idempotent) and spawn a peer teammate through the existing
 * peer-session pipeline (Kueue-admitted Sandbox, real sessions row, parent
 * lineage). Records the teammate in team_members.
 *
 * NOTE (remaining wiring): the teammate's agentConfig must also carry the team
 * MCP server with X-Wfb-Team-Id (so it can claim/message) and X-Wfb-Team-Depth
 * (so it cannot spawn nested teams). That stamping belongs in
 * sessions/spawn.ts::spawnSessionWorkflow alongside ensureGoalMcpServer — see
 * docs/agent-teams-phase1.md § "remaining wiring".
 */
export const POST: RequestHandler = async ({ params, request }) => {
	if (!validateInternalToken(request)) return error(401, "Unauthorized");
	const body = (await request.json().catch(() => ({}))) as {
		leadSessionId?: string;
		agentSlug?: string;
		name?: string;
		prompt?: string;
		model?: string;
		planModeRequired?: boolean;
	};
	if (!body.leadSessionId || !body.agentSlug || !body.name || !body.prompt) {
		return error(400, "leadSessionId, agentSlug, name, and prompt are required");
	}

	// Resolve the lead session's project (teams are project-scoped).
	const projRows = (await db.execute(
		sql`SELECT project_id FROM sessions WHERE id = ${body.leadSessionId} LIMIT 1`,
	)) as Array<{ project_id: string | null }>;
	const projectId = projRows[0]?.project_id;
	if (!projectId) return error(400, "lead session not found or has no project");

	await ensureTeam(
		{ teamId: params.teamId, leadSessionId: body.leadSessionId, projectId },
		db as unknown as TeamsDb,
	);

	// Give the team a container execution (created once) so it renders as ONE
	// unified run and all teammate sessions roll up under it. Also sets
	// teams.workflow_execution_id + stamps the lead session.
	const teamExecId = await ensureTeamRunExecution(
		{
			teamId: params.teamId,
			projectId,
			leadSessionId: body.leadSessionId,
			name: body.name,
			prompt: body.prompt,
		},
		db,
	);

	const agent = await resolveAgentIdBySlug(
		projectId,
		body.agentSlug,
		db as unknown as TeamsDb,
	);
	if (!agent) return error(404, `no agent '${body.agentSlug}' in this project`);

	// Deterministic, ≤64-char session id (peer-spawn requirement).
	const teammateSessionId = `tm-${params.teamId}-${body.name}`.slice(0, 64);

	// Record membership BEFORE spawning the workflow: spawnSessionWorkflow →
	// spawn.ts looks up this row to stamp X-Wfb-Team-Id + X-Wfb-Team-Depth onto
	// the teammate's MCP config, so the teammate boots with team scope.
	const member = await addMember(
		{
			teamId: params.teamId,
			sessionId: teammateSessionId,
			name: body.name,
			agentSlug: body.agentSlug,
			model: body.model ?? null,
			planModeRequired: body.planModeRequired ?? false,
		},
		db as unknown as TeamsDb,
	);

	const spawn = await getApplicationAdapters().peerSessionSpawn.spawnPeerSession({
		sessionId: teammateSessionId,
		peerAgentId: agent.id,
		prompt: body.prompt,
		parentSessionId: body.leadSessionId,
		title: `teammate:${body.name}`,
	});
	if (spawn.status === "error") return error(spawn.httpStatus, spawn.message);

	// Roll the teammate session up under the team run.
	await linkSessionToTeamRun(teammateSessionId, teamExecId, db);

	return json(
		{ ok: true, name: member.name, sessionId: teammateSessionId, spawn: spawn.body },
		{ status: spawn.httpStatus ?? 200 },
	);
};

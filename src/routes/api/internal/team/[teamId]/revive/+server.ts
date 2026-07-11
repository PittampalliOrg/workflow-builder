import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { validateInternalToken } from "$lib/server/internal-auth";
import { getApplicationAdapters } from "$lib/server/application";
import { getTeamBudget } from "$lib/server/teams/team-budget";
import { linkSessionToTeamRun } from "$lib/server/teams/team-run";

/**
 * POST /api/internal/team/[teamId]/revive
 *   { requestedBySessionId, name, prompt? }
 *
 * Teammate revival (Codex `resume_agent` parity): respawn a SHUTDOWN or FAILED
 * member under the SAME name with a fresh session. Shutdown stays terminal for
 * the old session (never resurrected — #497); the member IDENTITY carries over
 * by re-pointing the team_members row at the new session. The new session gets
 * a revival prompt referencing its predecessor (whose transcript remains
 * readable in the UI) plus any fresh instruction from the lead.
 *
 * Only the team's lead may revive. Budget-gated like spawn.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	if (!validateInternalToken(request)) return error(401, "Unauthorized");
	const body = (await request.json().catch(() => ({}))) as {
		requestedBySessionId?: string;
		name?: string;
		prompt?: string;
	};
	if (!body.requestedBySessionId || !body.name) {
		return error(400, "requestedBySessionId and name are required");
	}
	const store = getApplicationAdapters().teamStore;

	const team = await store.getTeam(params.teamId);
	if (!team) return error(404, "no such team");
	if (team.lead_session_id !== body.requestedBySessionId) {
		return error(403, "only the team lead can revive a teammate");
	}

	const member = await store.getMemberByName(params.teamId, body.name);
	if (!member) return error(404, `no teammate '${body.name}' in this team`);
	if (member.status !== "shutdown" && member.status !== "failed") {
		return error(
			400,
			`teammate '${body.name}' is ${member.status} — only shutdown/failed teammates can be revived`,
		);
	}

	const budget = await getTeamBudget(params.teamId, store).catch(() => null);
	if (budget?.exhausted) {
		return error(
			400,
			`team token budget exhausted (${budget.used}/${budget.budget}) — cannot revive '${body.name}'`,
		);
	}

	if (!member.agent_slug) {
		return error(400, `teammate '${body.name}' has no recorded agent slug to respawn from`);
	}
	const projectId = await store.getSessionProjectId(team.lead_session_id);
	if (!projectId) return error(400, "lead session not found or has no project");
	const agent = await store.resolveAgentIdBySlug(projectId, member.agent_slug);
	if (!agent) return error(404, `agent '${member.agent_slug}' no longer exists in this project`);

	const priorSessionId = member.session_id;
	// Generation suffix keeps the id deterministic-ish, unique, and ≤64 chars.
	const gen = Date.now().toString(36);
	const newSessionId = `tm-${params.teamId}-${body.name}-r${gen}`.slice(0, 64);

	const revivalPrompt = [
		`You are "${body.name}", REVIVED into your team after your previous session (${priorSessionId}) ${member.status === "failed" ? "failed" : "was shut down"}.`,
		"You do not inherit that session's memory — treat the team task list and teammate messages as ground truth for what remains.",
		"Call claim_task to pick up your next unblocked task.",
		body.prompt?.trim() ? `\nLead's instruction: ${body.prompt.trim()}` : "",
	]
		.filter(Boolean)
		.join("\n");

	const spawn = await getApplicationAdapters().peerSessionSpawn.spawnPeerSession({
		sessionId: newSessionId,
		peerAgentId: agent.id,
		prompt: revivalPrompt,
		parentSessionId: team.lead_session_id,
		title: `teammate:${body.name}`,
		provisionSandbox: true,
	});
	if (spawn.status === "error") return error(spawn.httpStatus, spawn.message);

	// Re-point the member identity at the fresh session, roll it up under the
	// team run, and record lineage (best-effort) for the UI.
	await store.setMemberSession({
		memberId: member.id,
		sessionId: newSessionId,
		status: "working",
	});
	const execId = await store.getTeamExecutionId(params.teamId).catch(() => null);
	if (execId) await linkSessionToTeamRun(newSessionId, execId).catch(() => {});

	return json({
		ok: true,
		name: body.name,
		sessionId: newSessionId,
		previousSessionId: priorSessionId,
		spawn: spawn.body,
	});
};

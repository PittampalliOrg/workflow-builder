import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { validateInternalToken } from "$lib/server/internal-auth";
import { getApplicationAdapters } from "$lib/server/application";
import {
	addMember,
	ensureTeam,
	listMembers,
	resolveAgentIdBySlug,
} from "$lib/server/teams/team-repo";

/** Cost guardrail (Codex-ultra parity: their concurrency cap + warning): a
 * team may not exceed this many members incl. the lead. Proactive leads and
 * runaway scripts hit a clear 400 instead of silently fanning out. */
const TEAM_MAX_MEMBERS = () => {
	const raw = Number(process.env.TEAM_MAX_MEMBERS ?? 8);
	return Number.isFinite(raw) && raw >= 2 ? Math.trunc(raw) : 8;
};
import {
	ensureTeamRunExecution,
	linkSessionToTeamRun,
} from "$lib/server/teams/team-run";
import { getTeamBudget } from "$lib/server/teams/team-budget";

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
	const projectId = await getApplicationAdapters().teamStore.getSessionProjectId(
		body.leadSessionId,
	);
	if (!projectId) return error(400, "lead session not found or has no project");

	await ensureTeam({
		teamId: params.teamId,
		leadSessionId: body.leadSessionId,
		projectId,
	});

	// Guardrail: cap the team size BEFORE provisioning anything expensive.
	const members = await listMembers(params.teamId);
	const cap = TEAM_MAX_MEMBERS();
	if (members.length >= cap) {
		return error(
			400,
			`team is at its member cap (${cap}, incl. the lead) — shut a teammate down first or raise TEAM_MAX_MEMBERS`,
		);
	}

	// Token-budget gate (Codex RolloutBudget parity): an exhausted team may not
	// grow. Deterministic refusal (4xx) so a script's team.spawn surfaces it as
	// a catchable error rather than retrying.
	const budget = await getTeamBudget(params.teamId).catch(() => null);
	if (budget?.exhausted) {
		return error(
			400,
			`team token budget exhausted (${budget.used}/${budget.budget} tokens used) — cannot spawn '${body.name}'. Finish with the teammates you have.`,
		);
	}

	// Give the team a container execution (created once) so it renders as ONE
	// unified run and all teammate sessions roll up under it. Also sets
	// teams.workflow_execution_id + stamps the lead session.
	const teamExecId = await ensureTeamRunExecution({
		teamId: params.teamId,
		projectId,
		leadSessionId: body.leadSessionId,
		name: body.name,
		prompt: body.prompt,
	});

	const agent = await resolveAgentIdBySlug(projectId, body.agentSlug);
	if (!agent) return error(404, `no agent '${body.agentSlug}' in this project`);

	// Deterministic, ≤64-char session id (peer-spawn requirement).
	const teammateSessionId = `tm-${params.teamId}-${body.name}`.slice(0, 64);

	// Record membership BEFORE spawning the workflow: spawnSessionWorkflow →
	// spawn.ts looks up this row to stamp X-Wfb-Team-Id + X-Wfb-Team-Depth onto
	// the teammate's MCP config, so the teammate boots with team scope.
	const member = await addMember({
		teamId: params.teamId,
		sessionId: teammateSessionId,
		name: body.name,
		agentSlug: body.agentSlug,
		model: body.model ?? null,
		planModeRequired: body.planModeRequired ?? false,
	});

	// Plan-approval handshake: a plan-mode teammate must plan first — claim_task
	// is gated server-side until the lead approves (claim route), and this
	// fragment teaches the protocol (submit_plan → wait for approval).
	const planFragment = body.planModeRequired
		? "\n\n# Plan approval required\nYou are in PLAN MODE. Before doing any work: study the task, write a concrete plan, and call submit_plan with it. You cannot claim tasks until the lead approves your plan (you will receive an approval or revision-request message). If revisions are requested, update the plan and submit_plan again."
		: "";

	const spawn = await getApplicationAdapters().peerSessionSpawn.spawnPeerSession({
		sessionId: teammateSessionId,
		peerAgentId: agent.id,
		prompt: `${body.prompt}${planFragment}`,
		parentSessionId: body.leadSessionId,
		title: `teammate:${body.name}`,
		// Teammates do real file/command work — give each its own OpenShell
		// workspace sandbox (otherwise the runtime's filesystem/bash tools fail
		// with "OpenShell sandboxName is required").
		provisionSandbox: true,
	});
	if (spawn.status === "error") return error(spawn.httpStatus, spawn.message);

	// Roll the teammate session up under the team run.
	await linkSessionToTeamRun(teammateSessionId, teamExecId);

	return json(
		{ ok: true, name: member.name, sessionId: teammateSessionId, spawn: spawn.body },
		{ status: spawn.httpStatus ?? 200 },
	);
};

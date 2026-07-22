import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import {
  buildTeamMemberSpawnPrompt,
  canonicalTeamMemberIdentity,
  createTeamMemberSessionId,
} from "$lib/server/application/team-member-launch";
import {
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
import { ensureTeamRunExecution } from "$lib/server/teams/team-run";
import { getTeamBudget } from "$lib/server/teams/team-budget";
import {
  authorizeTeamActionRequest,
  publicPeerSpawnProjection,
} from "../../team-action-principal";

/**
 * POST /api/internal/team/[teamId]/spawn
 *   { leadSessionId, agentSlug, name, prompt, model?, planModeRequired? }
 *
 * Form the team (idempotent) and spawn a peer teammate through the existing
 * peer-session pipeline (Kueue-admitted Sandbox, real sessions row, parent
 * lineage). Membership is reserved as non-working before dispatch and promoted
 * only after the child is durably linked to the active team run.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const body = (await request.json().catch(() => ({}))) as {
		leadSessionId?: string;
		agentSlug?: string;
		name?: string;
		prompt?: string;
		model?: string;
		planModeRequired?: boolean;
	};
  const authorization = await authorizeTeamActionRequest(
    request,
    params.teamId,
    {
      bodySessionId: body.leadSessionId,
      requiredRole: "lead",
      allowUnformedLeadTeam: true,
    },
  );
  if (!authorization.ok)
    return error(authorization.status, authorization.error);
  const leadSessionId = authorization.principal.sessionId;
  const identity = canonicalTeamMemberIdentity(body.name);
  if (!body.agentSlug || !identity || !body.prompt) {
    return error(400, "agentSlug, name, and prompt are required");
	}
  const { name, title } = identity;
  const application = getApplicationAdapters();
  const teammateSessionId = createTeamMemberSessionId({
    teamId: params.teamId,
    name,
  });
  const reservation = {
    teamId: params.teamId,
    sessionId: teammateSessionId,
    name,
    agentSlug: body.agentSlug,
    model: body.model ?? null,
    planModeRequired: body.planModeRequired ?? false,
  };
  const dispatchIntent = {
    prompt: buildTeamMemberSpawnPrompt(
      body.prompt,
      body.planModeRequired ?? false,
    ),
    title,
    skipSpawn: false,
    provisionSandbox: true,
    sandboxTemplate: null,
  };
  const replay = await application.teamMemberLaunch.inspectNewMemberReplay(
    reservation,
    authorization.principal,
    dispatchIntent,
  );
  if (replay?.status === "error") {
    return error(replay.httpStatus, replay.message);
  }
  if (replay) {
    return json(
      {
        ok: true,
        name: replay.member.name,
        sessionId: replay.member.session_id,
        spawn: publicPeerSpawnProjection(replay.spawn.body),
      },
      { status: replay.spawn.httpStatus ?? 200 },
    );
  }

  const projectId = authorization.principal.projectId;
  const agent = await resolveAgentIdBySlug(projectId, body.agentSlug);
  if (!agent) return error(404, `no agent '${body.agentSlug}' in this project`);
  const eligibility =
    await application.teamMailboxEligibility.checkParticipants({
      leadSessionId,
      memberAgentId: agent.id,
    });
  if (eligibility.status === "error") {
    return error(eligibility.httpStatus, eligibility.message);
  }

	await ensureTeam({
		teamId: params.teamId,
    leadSessionId,
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
      `team token budget exhausted (${budget.used}/${budget.budget} tokens used) — cannot spawn '${name}'. Finish with the teammates you have.`,
		);
	}

	// Give the team a container execution (created once) so it renders as ONE
	// unified run and all teammate sessions roll up under it. Also sets
	// teams.workflow_execution_id + stamps the lead session.
  await ensureTeamRunExecution({
		teamId: params.teamId,
		projectId,
    leadSessionId,
    name,
		prompt: body.prompt,
	});

  const launch = await application.teamMemberLaunch.startNewMember({
    agentId: agent.id,
    agentVersion: eligibility.agentVersion,
    reservation,
    peerRequest: {
		sessionId: teammateSessionId,
		peerAgentId: agent.id,
      peerAgentVersion: eligibility.agentVersion,
        parentSessionId: leadSessionId,
		// Teammates do real file/command work — give each its own OpenShell
		// workspace sandbox (otherwise the runtime's filesystem/bash tools fail
		// with "OpenShell sandboxName is required").
      ...dispatchIntent,
      },
    principal: authorization.principal,
  });
  if (launch.status === "error") {
    return error(launch.httpStatus, launch.message);
  }

	return json(
    {
      ok: true,
      name: launch.member.name,
      sessionId: teammateSessionId,
      spawn: publicPeerSpawnProjection(launch.spawn.body),
    },
    { status: launch.spawn.httpStatus ?? 200 },
	);
};

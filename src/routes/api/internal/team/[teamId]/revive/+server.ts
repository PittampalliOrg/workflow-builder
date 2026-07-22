import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import {
  buildTeamMemberRevivalPrompt,
  canonicalTeamMemberIdentity,
  createTeamMemberSessionId,
} from "$lib/server/application/team-member-launch";
import type { TerminalTeamMemberStatus } from "$lib/server/application/ports";
import { getTeamBudget } from "$lib/server/teams/team-budget";
import {
  authorizeTeamActionRequest,
  publicPeerSpawnProjection,
} from "../../team-action-principal";

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
	const body = (await request.json().catch(() => ({}))) as {
		requestedBySessionId?: string;
		name?: string;
		prompt?: string;
	};
  const authorization = await authorizeTeamActionRequest(
    request,
    params.teamId,
    {
      bodySessionId: body.requestedBySessionId,
      requiredRole: "lead",
    },
  );
  if (!authorization.ok)
    return error(authorization.status, authorization.error);
  const identity = canonicalTeamMemberIdentity(body.name);
  if (!identity) return error(400, "name is required");
  const { name, title } = identity;
  const application = getApplicationAdapters();
  const replay = await application.teamMemberLaunch.inspectMemberRevivalReplay(
    {
      teamId: params.teamId,
      name,
      prompt: body.prompt,
    },
    authorization.principal,
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
        previousSessionId: replay.member.launch_previous_session_id,
        spawn: publicPeerSpawnProjection(replay.spawn.body),
      },
      { status: replay.spawn.httpStatus ?? 200 },
    );
	}
  const store = application.teamStore;

	const team = await store.getTeam(params.teamId);
	if (!team) return error(404, "no such team");

  const member = await store.getMemberByName(params.teamId, name);
  if (!member) return error(404, `no teammate '${name}' in this team`);
	if (member.status !== "shutdown" && member.status !== "failed") {
		return error(
			400,
      `teammate '${name}' is ${member.status} — only shutdown/failed teammates can be revived`,
		);
	}

	const budget = await getTeamBudget(params.teamId, store).catch(() => null);
	if (budget?.exhausted) {
		return error(
			400,
      `team token budget exhausted (${budget.used}/${budget.budget}) — cannot revive '${name}'`,
		);
	}

	if (!member.agent_slug) {
    return error(
      400,
      `teammate '${name}' has no recorded agent slug to respawn from`,
    );
	}
	const projectId = await store.getSessionProjectId(team.lead_session_id);
	if (!projectId) return error(400, "lead session not found or has no project");
	const agent = await store.resolveAgentIdBySlug(projectId, member.agent_slug);
  if (!agent)
    return error(
      404,
      `agent '${member.agent_slug}' no longer exists in this project`,
    );
  const eligibility =
    await application.teamMailboxEligibility.checkParticipants({
      leadSessionId: authorization.principal.sessionId,
      memberAgentId: agent.id,
    });
  if (eligibility.status === "error") {
    return error(eligibility.httpStatus, eligibility.message);
  }

	const priorSessionId = member.session_id;
  const priorStatus: TerminalTeamMemberStatus =
    member.status === "failed" ? "failed" : "shutdown";
  // Retry-stable for the current predecessor. After a successful revival the
  // member points at the new session, so a later revival gets a new generation.
  const newSessionId = createTeamMemberSessionId({
    teamId: params.teamId,
    name,
    previousSessionId: priorSessionId,
  });

  const revivalPrompt = buildTeamMemberRevivalPrompt({
    name,
    previousSessionId: priorSessionId,
    previousStatus: priorStatus,
    prompt: body.prompt,
  });

  const launch = await application.teamMemberLaunch.reviveMember({
    agentId: agent.id,
    agentVersion: eligibility.agentVersion,
    reservation: {
      teamId: params.teamId,
      memberId: member.id,
      previousSessionId: priorSessionId,
      previousStatus: priorStatus,
      sessionId: newSessionId,
    },
    peerRequest: {
		sessionId: newSessionId,
		peerAgentId: agent.id,
      peerAgentVersion: eligibility.agentVersion,
		prompt: revivalPrompt,
        parentSessionId: authorization.principal.sessionId,
      title,
		provisionSandbox: true,
      },
    principal: authorization.principal,
	});
  if (launch.status === "error") {
    return error(launch.httpStatus, launch.message);
  }
  return json(
    {
		ok: true,
      name,
		sessionId: newSessionId,
		previousSessionId: priorSessionId,
      spawn: publicPeerSpawnProjection(launch.spawn.body),
    },
    { status: launch.spawn.httpStatus ?? 200 },
  );
};

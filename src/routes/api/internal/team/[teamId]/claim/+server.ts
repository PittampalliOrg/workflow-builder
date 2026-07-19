import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { claimNextTask } from "$lib/server/teams/team-tasks";
import { getMemberBySession } from "$lib/server/teams/team-repo";
import { authorizeTeamActionRequest } from "../../team-action-principal";

/**
 * POST /api/internal/team/[teamId]/claim  { sessionId }
 *
 * The single home of the atomic claim (FOR UPDATE SKIP LOCKED, dependency-aware,
 * pre-assigned-first). The MCP `claim_task` tool routes here so the claim SQL
 * lives in one place. Returns { task } — the claimed task, or null when nothing
 * is claimable.
 *
 * Plan-mode gate: a member spawned with planModeRequired cannot claim until the
 * lead approves its plan (submit_plan → approve_plan) — the enforceable core of
 * the Claude Code plan-approval handshake.
 */
export const POST: RequestHandler = async ({ params, request }) => {
  const body = (await request.json().catch(() => ({}))) as {
    sessionId?: string;
  };
  const authorization = await authorizeTeamActionRequest(
    request,
    params.teamId,
    {
      bodySessionId: body.sessionId,
    },
  );
  if (!authorization.ok)
    return error(authorization.status, authorization.error);
  const sessionId = authorization.principal.sessionId;
  const member = await getMemberBySession(sessionId).catch(() => null);
	if (member && member.team_id === params.teamId && member.plan_mode_required) {
		return json({
			task: null,
			blocked: "plan_approval_required",
			message:
				"You are in plan mode: submit your plan with submit_plan and wait for the lead's approval before claiming tasks.",
		});
	}
	const task = await claimNextTask({
		teamId: params.teamId,
    sessionId,
	});
	return json({ task });
};

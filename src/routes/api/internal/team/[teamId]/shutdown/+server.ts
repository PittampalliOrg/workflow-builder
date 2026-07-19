import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getMemberByName, setMemberStatus } from "$lib/server/teams/team-repo";
import { stopDurableRun } from "$lib/server/lifecycle";
import { authorizeTeamActionRequest } from "../../team-action-principal";

/**
 * POST /api/internal/team/[teamId]/shutdown  { requestedBySessionId?, name }
 *
 * Gracefully shut a teammate down. Routes through the Lifecycle Controller
 * (stopDurableRun, cooperative terminate) — NEVER an external Dapr terminate,
 * because teammate sessions are per-session task hubs (the durable/run wedge).
 */
export const POST: RequestHandler = async ({ params, request }) => {
  const body = (await request.json().catch(() => ({}))) as {
    requestedBySessionId?: string;
    name?: string;
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
	if (!body.name) return error(400, "name is required");

	const member = await getMemberByName(params.teamId, body.name);
	if (!member) return error(404, `no teammate '${body.name}' in this team`);
  if (member.role === "lead")
    return error(400, "cannot shut down the team lead");

	const result = await stopDurableRun(
		{ kind: "session", id: member.session_id },
		{ mode: "terminate", reason: "team shutdown" },
	);
	await setMemberStatus(member.session_id, "shutdown");
	return json({ ok: true, name: member.name, stop: result });
};

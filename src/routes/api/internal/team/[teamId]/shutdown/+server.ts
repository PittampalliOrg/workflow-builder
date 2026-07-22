import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
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

  const result = await getApplicationAdapters().teamShutdown.shutdownMember({
    teamId: params.teamId,
    name: body.name,
  });
  if (result.status === "not_found") return error(404, result.message);
  if (result.status === "invalid") return error(400, result.message);
  if (result.status === "unavailable") return error(503, result.message);
  if (result.status === "stopping") {
    return json(
      { ok: false, state: "stopping", name: result.name, stop: result.stop },
      { status: 202, headers: { "retry-after": "5" } },
	);
  }
  return json({
    ok: true,
    state: "confirmed",
    name: result.name,
    ...("stop" in result
      ? { stop: result.stop }
      : { terminalEvidence: result.terminalEvidence }),
  });
};

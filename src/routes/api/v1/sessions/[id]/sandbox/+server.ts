import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type { SessionSandboxCommandResult } from "$lib/server/application/session-sandboxes";

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");

	// Reaping a per-session Sandbox CR is exactly what stopDurableRun(mode:'purge')
	// does as its FINAL step after confirming the run is terminal. Doing it
	// standalone on a LIVE run yanks the pod out from under the session_workflow and
	// creates the DB↔Dapr divergence the lifecycle SSOT exists to prevent. So enforce
	// CMA scope and refuse while the run is active — stop it first (POST .../stop).
	return sessionSandboxResponse(
		await getApplicationAdapters().sessionSandboxes.deleteSessionSandboxes({
			sessionId: params.id,
			projectId: locals.session.projectId ?? null,
			userId: locals.session.userId,
		}),
	);
};

function sessionSandboxResponse(result: SessionSandboxCommandResult) {
	if (result.status === "not_found") return error(404, result.message);
	if (result.status === "conflict") return error(409, result.message);
	return json(result.body, { status: result.httpStatus ?? 200 });
}

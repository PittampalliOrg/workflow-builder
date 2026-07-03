import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type { SessionLifecycleResult } from "$lib/server/application/session-lifecycle";

/**
 * Pause a session — reversible Dapr `suspend_workflow` hold (NOT a stop). The
 * run stays alive (`SUSPENDED`) and resumable on demand. Session-scoped (the
 * caller must own the run) — mirrors the /control/interrupt route.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	return sessionLifecycleResponse(
		await getApplicationAdapters().sessionLifecycle.pauseSession({
			sessionId: params.id,
			projectId: locals.session.projectId ?? null,
			userId: locals.session.userId,
		}),
	);
};

function sessionLifecycleResponse(result: SessionLifecycleResult) {
	if (result.status === "not_found") return error(404, result.message);
	if (result.status === "conflict") return error(409, result.message);
	if (result.status === "unavailable") return error(503, result.message);
	return json(result.body, { status: result.httpStatus ?? 200 });
}

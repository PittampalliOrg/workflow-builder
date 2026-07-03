import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type { SessionLifecycleResult } from "$lib/server/application/session-lifecycle";

/**
 * Resume a paused session — Dapr `resume_workflow`, un-suspending the held run.
 * Session-scoped (the caller must own the run). Distinct from interactive-cli
 * conversation resume (POST /api/v1/sessions with resumeFromSessionId), which
 * re-mounts a transcript into a NEW session.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	return sessionLifecycleResponse(
		await getApplicationAdapters().sessionLifecycle.resumeSession({
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

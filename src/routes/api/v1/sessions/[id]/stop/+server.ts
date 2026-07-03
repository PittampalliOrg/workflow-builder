import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type { SessionLifecycleResult } from "$lib/server/application/session-lifecycle";

/**
 * POST /api/v1/sessions/[id]/stop
 *
 * The vetted way to stop a session's durable run. Body: { mode, reason?, graceMs? }.
 * - interrupt: cooperative halt of the current turn (keeps the session).
 * - terminate: hard-stop the durable run.
 * - purge / reset: terminate + purge durable state + reap the Sandbox CR + flip DB terminal.
 * Fail-closed: returns 409 if the durable run did not confirm closure.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	return sessionLifecycleResponse(
		await getApplicationAdapters().sessionLifecycle.stopSession({
			sessionId: params.id,
			projectId: locals.session.projectId ?? null,
			userId: locals.session.userId,
			body,
		}),
	);
};

function sessionLifecycleResponse(result: SessionLifecycleResult) {
	if (result.status === "not_found") return error(404, result.message);
	if (result.status === "conflict") return error(409, result.message);
	if (result.status === "unavailable") return error(503, result.message);
	return json(result.body, { status: result.httpStatus ?? 200 });
}

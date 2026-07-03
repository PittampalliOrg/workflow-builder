import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type { SessionLifecycleResult } from "$lib/server/application/session-lifecycle";

/**
 * Interrupt a running session — cooperative halt of the current turn at a safe
 * boundary. Routed through the vetted lifecycle controller (mode=interrupt),
 * which preserves the `user.interrupt` wire shape the runtime understands.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	return sessionLifecycleResponse(
		await getApplicationAdapters().sessionLifecycle.interruptSession({
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

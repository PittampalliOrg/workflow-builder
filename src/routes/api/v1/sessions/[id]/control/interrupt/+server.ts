import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { raiseSessionEvent } from "$lib/server/sessions/control";

/**
 * Interrupt a running session. Delegates to the Dapr workflow's
 * external-event channel (session.user_events) with `{type:"user.interrupt"}`.
 * The workflow's run_turn helper halts at the next safe boundary.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const result = await raiseSessionEvent(params.id, "session.user_events", {
		events: [{ type: "user.interrupt" }],
	});
	if (!result.ok) return error(result.status, result.error ?? "interrupt failed");
	return json({ interrupted: true });
};

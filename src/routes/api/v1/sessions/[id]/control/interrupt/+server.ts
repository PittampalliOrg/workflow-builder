import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { stopDurableRun } from "$lib/server/lifecycle";

/**
 * Interrupt a running session — cooperative halt of the current turn at a safe
 * boundary. Routed through the vetted lifecycle controller (mode=interrupt),
 * which preserves the `user.interrupt` wire shape the runtime understands.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const result = await stopDurableRun(
		{ kind: "session", id: params.id },
		{ mode: "interrupt" },
	);
	if (result.notFound) return error(404, "Session not found");
	if (!result.confirmed) {
		return error(409, "Could not interrupt the session (it may not be running yet)");
	}
	return json({ interrupted: true });
};

import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { inspectDurableRun, stopDurableRun } from "$lib/server/lifecycle";
import { isResourceInScope } from "$lib/server/workflows/project-scope";

/**
 * Interrupt a running session — cooperative halt of the current turn at a safe
 * boundary. Routed through the vetted lifecycle controller (mode=interrupt),
 * which preserves the `user.interrupt` wire shape the runtime understands.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const target = { kind: "session" as const, id: params.id };
	const inspected = await inspectDurableRun(target);
	if (inspected.notFound) return error(404, "Session not found");
	if (inspected.scope && !isResourceInScope(inspected.scope, locals.session)) {
		return error(404, "Session not found");
	}
	const result = await stopDurableRun(target, { mode: "interrupt" });
	if (result.notFound) return error(404, "Session not found");
	if (!result.confirmed) {
		// Transient runtime hiccup on a live session → retryable 503; otherwise the
		// session isn't running yet → 409.
		if (result.retryable) {
			return error(503, "Interrupt could not be delivered right now — please retry.");
		}
		return error(409, "Could not interrupt the session (it may not be running yet)");
	}
	return json({ interrupted: true });
};

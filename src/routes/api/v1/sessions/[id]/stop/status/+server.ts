import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { confirmDurableStop, inspectDurableRun } from "$lib/server/lifecycle";
import { isResourceInScope } from "$lib/server/workflows/project-scope";

/**
 * GET /api/v1/sessions/[id]/stop/status
 *
 * Poll the convergence of a previously-requested session stop (UI shows
 * "Stopping…" after a 202 and polls until `state:"confirmed"`). Idempotent.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const target = { kind: "session" as const, id: params.id };
	const inspected = await inspectDurableRun(target);
	if (inspected.notFound) return error(404, "Session not found");
	if (inspected.scope && !isResourceInScope(inspected.scope, locals.session)) {
		return error(404, "Session not found");
	}
	const result = await confirmDurableStop(target);
	return json({ state: result.state });
};

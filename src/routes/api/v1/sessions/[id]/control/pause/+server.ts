import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { inspectDurableRun } from "$lib/server/lifecycle";
import { pauseDurableRun } from "$lib/server/lifecycle/pause";
import { isResourceInScope } from "$lib/server/workflows/project-scope";

/**
 * Pause a session — reversible Dapr `suspend_workflow` hold (NOT a stop). The
 * run stays alive (`SUSPENDED`) and resumable on demand. Session-scoped (the
 * caller must own the run) — mirrors the /control/interrupt route.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const target = { kind: "session" as const, id: params.id };
	const inspected = await inspectDurableRun(target);
	if (inspected.notFound) return error(404, "Session not found");
	if (inspected.scope && !isResourceInScope(inspected.scope, locals.session)) {
		return error(404, "Session not found");
	}
	const result = await pauseDurableRun(target);
	if (result.notFound) return error(404, "Session not found");
	if (!result.ok) {
		if (result.reason === "not_active")
			return error(409, "Session is not active — nothing to pause");
		if (result.reason === "no_runtime")
			return error(409, "Session has no running runtime to pause");
		return error(503, "Pause could not be applied right now — please retry.");
	}
	return json({ paused: true });
};

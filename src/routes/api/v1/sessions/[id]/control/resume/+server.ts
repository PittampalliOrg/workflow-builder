import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { inspectDurableRun } from "$lib/server/lifecycle";
import { resumeDurableRun } from "$lib/server/lifecycle/pause";
import { isResourceInScope } from "$lib/server/workflows/project-scope";

/**
 * Resume a paused session — Dapr `resume_workflow`, un-suspending the held run.
 * Session-scoped (the caller must own the run). Distinct from interactive-cli
 * conversation resume (POST /api/v1/sessions with resumeFromSessionId), which
 * re-mounts a transcript into a NEW session.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const target = { kind: "session" as const, id: params.id };
	const inspected = await inspectDurableRun(target);
	if (inspected.notFound) return error(404, "Session not found");
	if (inspected.scope && !isResourceInScope(inspected.scope, locals.session)) {
		return error(404, "Session not found");
	}
	const result = await resumeDurableRun(target);
	if (result.notFound) return error(404, "Session not found");
	if (!result.ok) {
		if (result.reason === "no_runtime")
			return error(409, "Session has no runtime to resume");
		return error(503, "Resume could not be applied right now — please retry.");
	}
	return json({ resumed: true });
};

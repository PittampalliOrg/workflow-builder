import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import type { SessionLifecycleResult } from "$lib/server/application/session-lifecycle";
import { getApplicationAdapters } from "$lib/server/application";
import { requireInternal } from "$lib/server/internal-auth";

export const POST: RequestHandler = async ({ params, request }) => {
	requireInternal(request);
	const sessionId = params.id;
	if (!sessionId) return error(400, "session id required");

	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const userId = typeof body.userId === "string" ? body.userId.trim() : "";
	if (!userId) return error(400, "userId required");
	const projectId =
		typeof body.projectId === "string" && body.projectId.trim()
			? body.projectId.trim()
			: null;

	const result = await getApplicationAdapters().sessionLifecycle.stopSession({
		sessionId,
		userId,
		projectId,
		body: {
			mode: typeof body.mode === "string" ? body.mode : "terminate",
			reason:
				typeof body.reason === "string" ? body.reason : "Stopped by workflow",
			graceMs: typeof body.graceMs === "number" ? body.graceMs : undefined,
		},
	});
	return sessionLifecycleResponse(result);
};

function sessionLifecycleResponse(result: SessionLifecycleResult) {
	if (result.status === "ok") {
		return json(result.body, { status: result.httpStatus ?? 200 });
	}
	const status =
		result.status === "not_found"
			? 404
			: result.status === "conflict"
				? 409
				: 503;
	return json({ ok: false, error: result.message }, { status });
}

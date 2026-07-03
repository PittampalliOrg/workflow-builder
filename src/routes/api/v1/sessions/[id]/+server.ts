import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type { SessionLifecycleResult } from "$lib/server/application/session-lifecycle";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const session = await getApplicationAdapters().workflowData.getSessionDetail({
		sessionId: params.id,
		projectId: locals.session.projectId ?? null,
		userId: locals.session.userId,
	});
	if (!session) return error(404, "Session not found");
	// Surface coordinator ownership so the session-detail page can PROACTIVELY hide
	// the generic Stop and link to the owning run's Cancel — parity with the
	// workflow-run page (which reads execution.owner), instead of only discovering it
	// reactively when a Stop click returns 409 coordinator_owned.
	const owner =
		await getApplicationAdapters().sessionLifecycle.getSessionCoordinatorOwner(
			params.id,
		);
	return json({ session, owner });
};

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const title = typeof body.title === "string" ? body.title : null;
	if (title === null) return error(400, "title is required");
	const session = await getApplicationAdapters().workflowData.updateSessionTitle({
		sessionId: params.id,
		title,
		projectId: locals.session.projectId ?? null,
		userId: locals.session.userId,
	});
	if (!session) return error(404, "Session not found");
	return json({ session });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	// Enforce CMA workspace scope before a destructive op (mirror the /stop route),
	// then block while the durable run is still active so we never orphan a live
	// session_workflow + sandbox. Stop it first (POST .../stop).
	return sessionLifecycleResponse(
		await getApplicationAdapters().sessionLifecycle.deleteSession({
			sessionId: params.id,
			projectId: locals.session.projectId ?? null,
			userId: locals.session.userId,
		}),
	);
};

export const PATCH: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	return sessionLifecycleResponse(
		await getApplicationAdapters().sessionLifecycle.archiveSession({
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

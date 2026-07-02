import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { inspectDurableRun } from "$lib/server/lifecycle";
import { ownsBenchmarkOrEvalRunForSession } from "$lib/server/lifecycle/ownership";
import { isResourceInScope } from "$lib/server/workflows/project-scope";

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
	const owner = await ownsBenchmarkOrEvalRunForSession(params.id).catch(() => null);
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
	const inspected = await inspectDurableRun({ kind: "session", id: params.id });
	if (inspected.notFound) return error(404, "Session not found");
	if (inspected.scope && !isResourceInScope(inspected.scope, locals.session)) {
		return error(404, "Session not found");
	}
	if (inspected.active) {
		return error(409, "Stop the run before deleting this session");
	}
	const ok = await getApplicationAdapters().workflowData.deleteSession({
		sessionId: params.id,
		projectId: locals.session.projectId ?? null,
		userId: locals.session.userId,
	});
	if (!ok) return error(404, "Session not found");
	return json({ deleted: true });
};

export const PATCH: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const inspected = await inspectDurableRun({ kind: "session", id: params.id });
	if (inspected.notFound) return error(404, "Session not found");
	if (inspected.scope && !isResourceInScope(inspected.scope, locals.session)) {
		return error(404, "Session not found");
	}
	if (inspected.active) {
		return error(409, "Stop the run before archiving this session");
	}
	const ok = await getApplicationAdapters().workflowData.archiveSession({
		sessionId: params.id,
		projectId: locals.session.projectId ?? null,
		userId: locals.session.userId,
	});
	if (!ok) return error(404, "Session not found");
	return json({ archived: true });
};

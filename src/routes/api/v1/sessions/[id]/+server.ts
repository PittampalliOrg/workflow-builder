import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	archiveSession,
	deleteSession,
	getSession,
	updateSessionTitle,
} from "$lib/server/sessions/registry";
import { inspectDurableRun } from "$lib/server/lifecycle";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const session = await getSession(params.id);
	if (!session) return error(404, "Session not found");
	return json({ session });
};

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const title = typeof body.title === "string" ? body.title : null;
	if (title === null) return error(400, "title is required");
	const session = await updateSessionTitle(params.id, title);
	if (!session) return error(404, "Session not found");
	return json({ session });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	// Block destructive delete while the durable run is still active, so we never
	// orphan a live session_workflow + sandbox. Stop it first (POST .../stop).
	const inspected = await inspectDurableRun({ kind: "session", id: params.id });
	if (!inspected.notFound && inspected.active) {
		return error(409, "Stop the run before deleting this session");
	}
	const ok = await deleteSession(params.id);
	if (!ok) return error(404, "Session not found");
	return json({ deleted: true });
};

export const PATCH: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const inspected = await inspectDurableRun({ kind: "session", id: params.id });
	if (!inspected.notFound && inspected.active) {
		return error(409, "Stop the run before archiving this session");
	}
	const ok = await archiveSession(params.id);
	if (!ok) return error(404, "Session not found");
	return json({ archived: true });
};

import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	archiveSession,
	deleteSession,
	getSession,
	updateSessionTitle,
} from "$lib/server/sessions/registry";

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
	const ok = await deleteSession(params.id);
	if (!ok) return error(404, "Session not found");
	return json({ deleted: true });
};

export const PATCH: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const ok = await archiveSession(params.id);
	if (!ok) return error(404, "Session not found");
	return json({ archived: true });
};

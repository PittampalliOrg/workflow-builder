import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	archiveFile,
	deleteFile,
	getFile,
} from "$lib/server/files/registry";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const file = await getFile(params.id);
	if (!file) return error(404, "File not found");
	return json({ file });
};

/** Archive — soft-delete; keeps the payload for audit/GC. */
export const PATCH: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const ok = await archiveFile(params.id, locals.session.userId);
	if (!ok) return error(404, "File not found");
	return json({ ok: true });
};

/** Hard-delete — removes metadata + payload bytes. */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const ok = await deleteFile(params.id, locals.session.userId);
	if (!ok) return error(404, "File not found");
	return json({ ok: true });
};

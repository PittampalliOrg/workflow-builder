import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { renameWorkspace } from "$lib/server/workspaces/registry";

/**
 * PATCH /api/v1/workspaces/[id] — rename. Only ADMINs of the project can
 * rename; non-ADMIN members get 403. externalId (URL slug) is immutable.
 */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const displayName =
		typeof body.displayName === "string" ? body.displayName.trim() : "";
	if (!displayName) return error(400, "displayName is required");
	const ok = await renameWorkspace(
		params.id,
		locals.session.userId,
		displayName,
	);
	if (!ok) return error(403, "Not authorized to rename this workspace");
	return json({ ok: true });
};

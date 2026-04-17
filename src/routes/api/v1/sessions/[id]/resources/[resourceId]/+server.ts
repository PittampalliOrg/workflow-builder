import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { removeResource } from "$lib/server/sessions/registry";

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const ok = await removeResource(params.id, params.resourceId);
	if (!ok) return error(404, "Resource not found");
	return json({ removed: true });
};

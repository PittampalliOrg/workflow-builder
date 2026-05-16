import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getSessionRuntimeConfig } from "$lib/server/sessions/runtime-config";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");

	const event = await getSessionRuntimeConfig(params.id, {
		projectId: locals.session.projectId ?? null,
	});
	if (!event) return error(404, "Runtime config not found");

	return json(event);
};

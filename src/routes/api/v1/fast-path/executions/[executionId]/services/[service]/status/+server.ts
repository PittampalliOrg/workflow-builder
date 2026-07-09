import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const result = await getApplicationAdapters().devPreviewSidecar.status({
		executionId: params.executionId,
		service: params.service,
		projectId: locals.session.projectId,
	});
	if (!result) return error(404, "Fast path service not found");
	return json(result);
};

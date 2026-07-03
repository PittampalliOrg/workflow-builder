import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const GET: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const itemMode = url.searchParams.get("items") === "summary" ? "summary" : "full";
	const result = await getApplicationAdapters().evaluationRunDetail.getRun({
		projectId: locals.session.projectId,
		runId: params.runId,
		itemMode,
	});
	if (result.status === "not_found") return error(404, result.message);
	return json(result.body);
};

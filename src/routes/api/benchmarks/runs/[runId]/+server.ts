import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const GET: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const includeStats = url.searchParams.get("stats") !== "false";
	const lite = url.searchParams.get("lite") === "true";
	const result = await getApplicationAdapters().benchmarkRunDetail.getApiDetail({
		projectId: locals.session.projectId,
		runId: params.runId,
		includeStats,
		lite,
	});
	if (result.status === "not_found") return error(404, result.message);
	return json(result.body);
};

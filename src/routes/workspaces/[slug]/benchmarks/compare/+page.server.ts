import { error } from "@sveltejs/kit";
import { getApplicationAdapters } from "$lib/server/application";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ url, locals }) => {
	if (!locals.session?.userId) error(401, "Authentication required");
	if (!locals.session.projectId) error(400, "No active workspace");

	return getApplicationAdapters().workflowData.getBenchmarkComparePageReadModel({
		projectId: locals.session.projectId,
		runsParam: url.searchParams.get("runs"),
		tag: url.searchParams.get("tag"),
	});
};

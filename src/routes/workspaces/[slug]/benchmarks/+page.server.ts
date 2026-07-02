import { error } from "@sveltejs/kit";
import { getApplicationAdapters } from "$lib/server/application";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.session?.userId) error(401, "Authentication required");

	return getApplicationAdapters().workflowData.getBenchmarkBrowserReadModel({
		projectId: locals.session.projectId ?? null,
	});
};

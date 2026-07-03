import { error } from "@sveltejs/kit";
import { getApplicationAdapters } from "$lib/server/application";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, locals }) => {
	const environment =
		await getApplicationAdapters().workflowData.getDevEnvironmentOrPending({
			executionId: params.executionId,
			projectId: locals.session?.projectId ?? null,
		});
	if (!environment) error(404, "Dev environment not found");
	return { environment };
};

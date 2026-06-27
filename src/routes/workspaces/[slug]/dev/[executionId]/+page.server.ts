import { error } from "@sveltejs/kit";
import { getDevEnvironmentOrPending } from "$lib/server/workflows/dev-environments";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, locals }) => {
	const environment = await getDevEnvironmentOrPending(
		params.executionId,
		locals.session?.projectId,
	);
	if (!environment) error(404, "Dev environment not found");
	return { environment };
};

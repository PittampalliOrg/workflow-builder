import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const suites = await getApplicationAdapters().benchmarkRouteOperations.listSuites(
		locals.session.projectId,
	);
	return json({ suites });
};

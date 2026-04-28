import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getBenchmarkRunEnvironmentActivity } from "$lib/server/environments/environment-image-builds";

export const GET: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Benchmark run not found");
	const activity = await getBenchmarkRunEnvironmentActivity(
		locals.session.projectId,
		params.runId,
		{ syncActive: url.searchParams.get("sync") === "1" },
	);
	if (!activity) return error(404, "Benchmark run not found");
	return json(activity);
};

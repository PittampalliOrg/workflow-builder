import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getEnvironmentBuildActivity } from "$lib/server/environments/environment-image-builds";

export const GET: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const activity = await getEnvironmentBuildActivity(params.buildId, {
		sync: url.searchParams.get("sync") !== "0",
		forceTerminal: true,
	});
	if (!activity) return error(404, "Environment build not found");
	return json(activity);
};

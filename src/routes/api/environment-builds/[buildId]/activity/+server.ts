import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const GET: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const activity =
		await getApplicationAdapters().environmentBuildActivity.getBuildActivity(
			params.buildId,
			{
				sync: url.searchParams.get("sync") !== "0",
				forceTerminal: true,
			},
		);
	if (!activity) return error(404, "Environment build not found");
	return json(activity);
};

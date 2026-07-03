import { error, json } from "@sveltejs/kit";
import { getApplicationAdapters } from "$lib/server/application";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.session?.userId) error(401, "Authentication required");

	const result = await getApplicationAdapters().benchmarkCompare.getApiCompare({
		projectId: locals.session.projectId ?? null,
		runsParam: url.searchParams.get("runs"),
	});
	if (result.status === "no_workspace") error(400, result.message);
	if (result.status === "bad_request") error(400, result.message);
	return json(result.body);
};

import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type { RunLaunchResult } from "$lib/server/application/run-launch";

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const limit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
	const tag = url.searchParams.get("tag");
	return json(await getApplicationAdapters().benchmarkRunLaunch.listRuns({
		projectId: locals.session.projectId,
		limit,
		tag: tag ?? null,
	}));
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const result = await getApplicationAdapters().benchmarkRunLaunch.startRun({
		projectId: locals.session.projectId,
		userId: locals.session.userId,
		body: await request.json().catch(() => ({})),
	});
	return respond(result);
};

function respond(result: RunLaunchResult) {
	if (result.status === "error") {
		if (result.body) return json(result.body, { status: result.httpStatus });
		return error(result.httpStatus, result.message ?? "Benchmark run failed");
	}
	return json(result.body, { status: result.httpStatus });
}

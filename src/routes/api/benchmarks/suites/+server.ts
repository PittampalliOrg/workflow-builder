import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { listBenchmarkSuites } from "$lib/server/benchmarks/service";

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const suites = await listBenchmarkSuites(locals.session.projectId);
	return json({ suites });
};

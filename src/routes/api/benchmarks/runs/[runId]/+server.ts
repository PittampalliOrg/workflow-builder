import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getBenchmarkRun } from "$lib/server/benchmarks/service";
import { computeRunStats } from "$lib/server/benchmarks/stats";

export const GET: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Benchmark run not found");
	const includeStats = url.searchParams.get("stats") !== "false";
	const lite = url.searchParams.get("lite") === "true";
	const run = await getBenchmarkRun(locals.session.projectId, params.runId);
	if (!run) return error(404, "Benchmark run not found");

	// Drop the heavy `harnessResult` blob from per-instance rows in the list
	// response. Callers fetch the parsed result via the per-instance endpoint
	// when the drawer opens. Keep the existing field on `lite=false` mode in
	// case any caller depends on it.
	const slimmedRun = lite
		? {
				...run,
				instances: (run.instances ?? []).map((i) => ({
					...i,
					harnessResult: null,
					testOutputSummary: null,
				})),
			}
		: run;

	const runStats = includeStats ? await computeRunStats(params.runId) : null;
	return json({ run: slimmedRun, runStats });
};

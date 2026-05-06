import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getBenchmarkRunCapacityDiagnostics } from "$lib/server/benchmarks/capacity-diagnostics";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Benchmark run not found");
	const diagnostics = await getBenchmarkRunCapacityDiagnostics(
		locals.session.projectId,
		params.runId,
	);
	if (!diagnostics) return error(404, "Benchmark run not found");
	return json({ diagnostics });
};

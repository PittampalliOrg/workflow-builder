import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import { requireInternal } from "$lib/server/internal-auth";
import { db } from "$lib/server/db";
import { benchmarkRuns } from "$lib/server/db/schema";
import { getBenchmarkRunCapacityDiagnostics } from "$lib/server/benchmarks/capacity-diagnostics";

export const GET: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	if (!db) return error(503, "Database not configured");
	const runId = params.runId;
	if (!runId) return error(400, "runId is required");
	const [run] = await db
		.select({ projectId: benchmarkRuns.projectId })
		.from(benchmarkRuns)
		.where(eq(benchmarkRuns.id, runId))
		.limit(1);
	if (!run) return error(404, "Benchmark run not found");
	const diagnostics = await getBenchmarkRunCapacityDiagnostics(
		run.projectId,
		runId,
	);
	const clusterPressure = diagnostics?.clusterPressure ?? null;
	const admitNewStarts =
		!!diagnostics &&
		diagnostics.pressureAdjustedConcurrency > 0 &&
		clusterPressure?.hardBlock !== true &&
		diagnostics.parentWorkflow.daprRuntimePressure !== true &&
		(diagnostics.sandbox.diskPressureNodeCount ?? 0) === 0 &&
		diagnostics.sandbox.kueueClusterQueueActive !== false;
	return json({
		success: true,
		admitNewStarts,
		retryAfterSeconds: admitNewStarts ? 0 : 30,
		reasons: diagnostics?.capReason?.split("+").filter(Boolean) ?? [],
		clusterPressure,
		parentWorkflow: diagnostics?.parentWorkflow ?? null,
		sandbox: diagnostics?.sandbox ?? null,
	});
};

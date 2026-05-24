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
		diagnostics.agentHostRuntime.daprRuntimePressure !== true &&
		(diagnostics.sandbox.diskPressureNodeCount ?? 0) === 0 &&
		diagnostics.sandbox.kueueClusterQueueActive !== false;
	const reasons = new Set(diagnostics?.capReason?.split("+").filter(Boolean) ?? []);
	if (diagnostics?.pressureAdjustedConcurrency === 0) reasons.add("no_capacity");
	if (clusterPressure?.hardBlock === true) reasons.add("cluster_pressure");
	if (diagnostics?.parentWorkflow.daprRuntimePressure === true) {
		reasons.add("parent_workflow_dapr_pressure");
	}
	if (diagnostics?.agentHostRuntime.daprRuntimePressure === true) {
		reasons.add("agent_host_dapr_pressure");
	}
	if ((diagnostics?.sandbox.diskPressureNodeCount ?? 0) > 0) {
		reasons.add("sandbox_disk_pressure");
	}
	if (diagnostics?.sandbox.kueueClusterQueueActive === false) {
		reasons.add("kueue_cluster_queue_inactive");
	}
	return json({
		success: true,
		admitNewStarts,
		retryAfterSeconds: admitNewStarts ? 0 : 30,
		reasons: [...reasons],
		clusterPressure,
		parentWorkflow: diagnostics?.parentWorkflow ?? null,
		agentHostRuntime: diagnostics?.agentHostRuntime ?? null,
		sandbox: diagnostics?.sandbox ?? null,
	});
};

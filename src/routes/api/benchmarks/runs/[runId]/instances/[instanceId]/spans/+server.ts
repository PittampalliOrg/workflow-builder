import { error, json } from "@sveltejs/kit";
import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { benchmarkRuns, benchmarkRunInstances } from "$lib/server/db/schema";
import {
	getMultiTraceLlmSpans,
	getMultiTraceToolSpans,
} from "$lib/server/otel/clickhouse";
import { publicMlflowTracesUrl } from "$lib/server/benchmarks/mlflow";
import type { RequestHandler } from "./$types";

// Phase D — span drilldown for the run-instance drawer Spans tab.
// Pure read-side: pulls already-emitted OTel spans from ClickHouse for the
// trace IDs we recorded on the row. No schema, no writes.
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Run not found");
	if (!db) return error(503, "Database not configured");
	const database = db;

	const runId = params.runId;
	const instanceId = decodeURIComponent(params.instanceId ?? "");
	if (!runId || !instanceId) return error(400, "runId and instanceId required");

	const [runRow] = await database
		.select({
			id: benchmarkRuns.id,
			mlflowExperimentId: benchmarkRuns.mlflowExperimentId,
		})
		.from(benchmarkRuns)
		.where(
			and(
				eq(benchmarkRuns.id, runId),
				eq(benchmarkRuns.projectId, locals.session.projectId),
			),
		)
		.limit(1);
	if (!runRow) return error(404, "Run not found");

	const [row] = await database
		.select({ traceIds: benchmarkRunInstances.traceIds })
		.from(benchmarkRunInstances)
		.where(
			and(
				eq(benchmarkRunInstances.runId, runId),
				eq(benchmarkRunInstances.instanceId, instanceId),
			),
		)
		.limit(1);
	if (!row) return error(404, "Instance not found in this run");

	const traceIds = (row.traceIds ?? []).filter(
		(t): t is string => typeof t === "string" && t.length > 0,
	);

	if (traceIds.length === 0) {
		return json({ traceIds: [], mlflowTracesUrl: null, llmSpans: [], toolSpans: [] });
	}

	const mlflowTracesUrl = publicMlflowTracesUrl(runRow.mlflowExperimentId, traceIds[0]);

	try {
		const [llmSpans, toolSpans] = await Promise.all([
			getMultiTraceLlmSpans(traceIds),
			getMultiTraceToolSpans(traceIds),
		]);
		llmSpans.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
		toolSpans.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
		return json({ traceIds, mlflowTracesUrl, llmSpans, toolSpans });
	} catch (err) {
		console.warn(`spans drilldown failed for ${runId}/${instanceId}:`, err);
		return json(
			{
				traceIds,
				mlflowTracesUrl,
				llmSpans: [],
				toolSpans: [],
				error: err instanceof Error ? err.message : String(err),
			},
			{ status: 200 },
		);
	}
};

// Phase H — promote a benchmark run instance into a dataset row, preserving
// a bidirectional `origin_run_instance_id` pointer back to the source.
// Body: { runId: string, instanceId: string }
//
// The dataset row's `input` captures the SWE-bench problem identity; `expected`
// captures the harness-graded outcome plus the patch metrics from Phase C —
// enough for a future eval to assert the agent should reach the same patch
// quality on the same problem.

import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const POST: RequestHandler = async ({ request, params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Evaluation dataset not found");

	const body = (await request.json().catch(() => ({}))) as {
		runId?: string;
		instanceId?: string;
	};

	let result;
	try {
		result = await getApplicationAdapters().workflowData.promoteBenchmarkRunInstanceToDataset({
			projectId: locals.session.projectId,
			datasetId: params.datasetId,
			runId: body.runId,
			instanceId: body.instanceId,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : "";
		if (/Database not configured/.test(message)) {
			return error(503, "Database not configured");
		}
		throw err;
	}

	if (result.status === "invalid_input") return error(400, result.message);
	if (result.status === "benchmark_instance_not_found") {
		return error(404, "Benchmark instance not found in this run");
	}
	if (result.status === "evaluation_dataset_not_found") {
		return error(404, "Evaluation dataset not found");
	}
	if (result.status === "run_in_different_workspace") {
		return error(403, "Run is in a different workspace");
	}

	return json(
		{
			rows: result.rows.map((row) => ({
				...row,
				createdAt: row.createdAt.toISOString(),
				updatedAt: row.updatedAt.toISOString(),
			})),
		},
		{ status: 201 },
	);
};

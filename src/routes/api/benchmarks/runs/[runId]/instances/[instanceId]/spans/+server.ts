import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

// ClickHouse-backed span drilldown for the run-instance drawer.
export const GET: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Run not found");

	const runId = params.runId;
	const instanceId = decodeURIComponent(params.instanceId ?? "");
	if (!runId || !instanceId) return error(400, "runId and instanceId required");
	const requestedLimit = Number(url.searchParams.get("limit"));
	const startedAt = url.searchParams.get("startedAt");
	const completedAt = url.searchParams.get("completedAt");

	try {
		const bundle = await getApplicationAdapters().benchmarkRouteOperations.loadTraceBundle({
			runId,
			instanceId,
			projectId: locals.session.projectId,
			options: {
				limit: Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : undefined,
				cursor: url.searchParams.get("cursor"),
				timeWindow:
					startedAt || completedAt
						? { startedAt, completedAt }
						: undefined,
			},
		});
		if (!bundle) return error(404, "Instance not found in this run");
		return json(bundle);
	} catch (err) {
		console.warn(`spans drilldown failed for ${runId}/${instanceId}:`, err);
		return json(
			{
				backend: "none",
				traceIds: [],
				mlflowTracesUrl: null,
				traceSpans: [],
				llmSpans: [],
				toolSpans: [],
				summary: {
					traceCount: 0,
					traceSpanCount: 0,
					llmSpanCount: 0,
					toolSpanCount: 0,
					errorSpanCount: 0,
					source: "none",
				},
				artifactPath: null,
				warnings: [err instanceof Error ? err.message : String(err)],
				truncated: false,
				nextCursor: null,
			},
			{ status: 200 },
		);
	}
};

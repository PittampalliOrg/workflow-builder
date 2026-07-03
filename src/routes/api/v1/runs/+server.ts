import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type { WorkflowExecutionStatus } from "$lib/server/application/ports";

const VALID_STATUSES: ReadonlyArray<WorkflowExecutionStatus> = [
	"pending",
	"running",
	"success",
	"error",
	"cancelled",
];

/**
 * GET /api/v1/runs
 *
 * Cross-workflow execution list for the current workspace. Scope comes
 * implicitly from `locals.session.projectId` (overridden by hooks.server.ts
 * when the request carries an X-Workspace header or lives under
 * /workspaces/[slug]/*). Sessions/executions from other workspaces are
 * silently excluded.
 *
 * Query params:
 *   workflowId — restrict to one workflow
 *   status     — one of pending|running|success|error|cancelled
 *   since      — ISO-8601 datetime; runs whose startedAt >= since
 *   q          — fuzzy match on workflow name or execution id (≥2 chars)
 *   limit      — 1..200; default 50
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.session?.userId) throw error(401, "Authentication required");
	if (!locals.session.projectId) {
		return json({ runs: [] });
	}

	const statusParam = url.searchParams.get("status");
	const status =
		statusParam && VALID_STATUSES.includes(statusParam as WorkflowExecutionStatus)
			? (statusParam as WorkflowExecutionStatus)
			: undefined;

	const sinceParam = url.searchParams.get("since");
	let since: Date | undefined;
	if (sinceParam) {
		const d = new Date(sinceParam);
		if (!Number.isNaN(d.getTime())) since = d;
	}

	const limitParam = url.searchParams.get("limit");
	const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;

	const runs = await getApplicationAdapters().workflowData.listProjectWorkflowRuns({
		projectId: locals.session.projectId,
		workflowId: url.searchParams.get("workflowId") ?? undefined,
		status,
		since,
		q: url.searchParams.get("q") ?? undefined,
		limit: Number.isFinite(limit) ? limit : undefined,
	});

	return json({ runs });
};

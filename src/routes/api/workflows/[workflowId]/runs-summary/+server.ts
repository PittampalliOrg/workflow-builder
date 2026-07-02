import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * GET /api/workflows/[workflowId]/runs-summary?limit=20
 *
 * Like /executions, but enriches each run with the set of bridge-spawned
 * sessions and the agents those sessions used. Drives the Agent + Session
 * columns on the workflow Runs tab. Computes in two selects + an in-memory
 * join so we don't need drizzle's leftJoin on a sparse relation.
 */
export const GET: RequestHandler = async ({ params, url }) => {
	const { workflowId } = params;
	const limit = parseInt(url.searchParams.get("limit") || "20");

	try {
		const executions =
			await getApplicationAdapters().workflowData.listWorkflowExecutionRunSummaries({
				workflowId,
				limit,
			});
		return json({ executions });
	} catch (err) {
		console.error(
			`[runs-summary] error for workflow ${workflowId}:`,
			err,
		);
		return json({ executions: [] });
	}
};

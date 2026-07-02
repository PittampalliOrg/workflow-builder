import { error, redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { isResourceInScope } from "$lib/server/workflows/project-scope";

/**
 * Shim route: resolve a workflow execution by id and 302 to the canonical
 * `/workflows/[workflowId]/runs/[executionId]` URL. Lets surfaces that only
 * know the executionId (e.g., the CMA session detail "Workflow run" card)
 * link through to the full run-detail page without carrying the workflowId
 * everywhere.
 */
export const load: PageServerLoad = async ({ params, locals, url }) => {
	const { executionId } = params;
	if (!locals.session?.userId) throw error(401, "Authentication required");

	const row = await getApplicationAdapters().workflowData.getExecutionById(executionId);

	if (!row) throw error(404, "Execution not found");

	// CMA scoping parity: 404 on cross-workspace lookup.
	if (!isResourceInScope(row, locals.session)) throw error(404, "Execution not found");

	throw redirect(
		302,
		`/workspaces/${encodeURIComponent(params.slug)}/workflows/${encodeURIComponent(row.workflowId)}/runs/${encodeURIComponent(executionId)}${url.search}`,
	);
};

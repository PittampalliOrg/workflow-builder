import { error, redirect } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import type { PageServerLoad } from "./$types";
import { db } from "$lib/server/db";
import { workflowExecutions } from "$lib/server/db/schema";

/**
 * Shim route: resolve a workflow execution by id and 302 to the canonical
 * `/workflows/[workflowId]/runs/[executionId]` URL. Lets surfaces that only
 * know the executionId (e.g., the CMA session detail "Workflow run" card)
 * link through to the full run-detail page without carrying the workflowId
 * everywhere.
 */
export const load: PageServerLoad = async ({ params, locals, url }) => {
	const { executionId } = params;
	if (!db) throw error(503, "Database not configured");
	if (!locals.session?.userId) throw error(401, "Authentication required");

	const [row] = await db
		.select({
			workflowId: workflowExecutions.workflowId,
			projectId: workflowExecutions.projectId,
			userId: workflowExecutions.userId,
		})
		.from(workflowExecutions)
		.where(eq(workflowExecutions.id, executionId))
		.limit(1);

	if (!row) throw error(404, "Execution not found");

	// CMA scoping parity: 404 on cross-workspace lookup.
	const scopedByProject =
		row.projectId && locals.session.projectId
			? row.projectId === locals.session.projectId
			: row.userId === locals.session.userId;
	if (!scopedByProject) throw error(404, "Execution not found");

	throw redirect(
		302,
		`/workflows/${encodeURIComponent(row.workflowId)}/runs/${encodeURIComponent(executionId)}${url.search}`,
	);
};

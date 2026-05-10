/**
 * GET /api/workflows/executions/[executionId]/artifacts
 *
 * User-facing read API for the run-detail UI. Returns the list of all
 * artifacts persisted for an execution, ordered by slot priority then
 * creation time. The `inlinePayload` of each artifact is included
 * directly so the renderer can display it without extra round-trips.
 *
 * Workspace-scoped via `assertInScope`. Cross-workspace access 404s.
 */

import { error, json } from "@sveltejs/kit";
import { and, asc, eq, sql } from "drizzle-orm";
import type { RequestHandler } from "./$types";
import { db } from "$lib/server/db";
import { workflowArtifacts, workflowExecutions } from "$lib/server/db/schema";
import { assertInScope } from "$lib/server/workflows/project-scope";

// Slot ordering for stable rendering: primary first, then secondary, aux,
// finally null. The CASE expression below maps slot → integer for ORDER BY.
const SLOT_RANK = sql<number>`CASE ${workflowArtifacts.slot}
	WHEN 'primary' THEN 0
	WHEN 'secondary' THEN 1
	WHEN 'aux' THEN 2
	ELSE 3
END`;

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!db) return error(503, "Database not configured");
	if (!locals.session?.userId) return error(401, "Authentication required");

	const { executionId } = params;
	if (!executionId) return error(400, "executionId required");

	// Workspace-scope check via the parent execution row.
	const execRows = await db
		.select({
			id: workflowExecutions.id,
			projectId: workflowExecutions.projectId,
			userId: workflowExecutions.userId,
		})
		.from(workflowExecutions)
		.where(eq(workflowExecutions.id, executionId))
		.limit(1);
	const exec = execRows[0];
	assertInScope(exec, locals.session, "Execution not found");

	const rows = await db
		.select()
		.from(workflowArtifacts)
		.where(eq(workflowArtifacts.workflowExecutionId, executionId))
		.orderBy(SLOT_RANK, asc(workflowArtifacts.createdAt));

	return json({ artifacts: rows });
};

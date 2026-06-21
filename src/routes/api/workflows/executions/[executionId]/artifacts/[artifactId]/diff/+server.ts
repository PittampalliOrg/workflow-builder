/**
 * GET /api/workflows/executions/[executionId]/artifacts/[artifactId]/diff
 *
 * Resolves the full unified-diff patch for a `diff` artifact — inline when
 * small, or gunzipped from the offloaded `files` blob when large. Lazy: the run
 * page only fetches this when the user opens the Changes view.
 *
 * Workspace-scoped via `assertInScope`.
 */

import { error, json } from "@sveltejs/kit";
import { and, eq } from "drizzle-orm";
import type { RequestHandler } from "./$types";
import { db } from "$lib/server/db";
import { workflowArtifacts, workflowExecutions } from "$lib/server/db/schema";
import { assertInScope } from "$lib/server/workflows/project-scope";
import { resolveRunDiffPatch, RUN_DIFF_KIND } from "$lib/server/workflows/run-diff";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!db) return error(503, "Database not configured");
	if (!locals.session?.userId) return error(401, "Authentication required");

	const { executionId, artifactId } = params;
	if (!executionId || !artifactId) return error(400, "executionId and artifactId required");

	const [exec] = await db
		.select({ id: workflowExecutions.id, projectId: workflowExecutions.projectId, userId: workflowExecutions.userId })
		.from(workflowExecutions)
		.where(eq(workflowExecutions.id, executionId))
		.limit(1);
	assertInScope(exec, locals.session, "Execution not found");

	const [artifact] = await db
		.select()
		.from(workflowArtifacts)
		.where(
			and(
				eq(workflowArtifacts.id, artifactId),
				eq(workflowArtifacts.workflowExecutionId, executionId),
			),
		)
		.limit(1);
	if (!artifact || artifact.kind !== RUN_DIFF_KIND) {
		return error(404, "Diff artifact not found");
	}

	const resolved = await resolveRunDiffPatch(artifact);
	if (!resolved) return error(404, "Diff artifact not found");

	return json(resolved);
};

/**
 * GET /api/workflows/executions/[executionId]/versions
 *
 * Per-run "Code versions" list: every `source-bundle` artifact this execution
 * produced (the durable, promotable code versions — see
 * docs/code-version-persistence.md). For dev-pod-as-source GAN runs this is one
 * `tier:"tar-overlay"` version per loop iteration (the deterministic id includes
 * `iteration`); for `/sandbox/work` runs it's the session-end git bundle. Each
 * row pairs with `…/versions/[artifactId]/promote` for the manual Promote → PR.
 * Workspace-scoped.
 */

import { error, json } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import type { RequestHandler } from "./$types";
import { db } from "$lib/server/db";
import { workflowExecutions } from "$lib/server/db/schema";
import { assertInScope } from "$lib/server/workflows/project-scope";
import { listSourceBundlesForExecution } from "$lib/server/workflows/source-bundle";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!db) return error(503, "Database not configured");
	if (!locals.session?.userId) return error(401, "Authentication required");
	const { executionId } = params;
	if (!executionId) return error(400, "executionId required");

	const [exec] = await db
		.select({
			id: workflowExecutions.id,
			projectId: workflowExecutions.projectId,
			userId: workflowExecutions.userId,
		})
		.from(workflowExecutions)
		.where(eq(workflowExecutions.id, executionId))
		.limit(1);
	assertInScope(exec, locals.session, "Execution not found");

	const rows = await listSourceBundlesForExecution(executionId);
	const versions = rows.map((r) => ({
		artifactId: r.id,
		executionId: r.workflowExecutionId,
		nodeId: r.nodeId,
		fileId: r.fileId,
		sizeBytes: r.sizeBytes,
		title: r.title,
		payload: r.inlinePayload,
		// Durable version→GitHub-PR status (set by promote); null = not yet pushed.
		promotion: (r.metadata as { promotion?: unknown } | null)?.promotion ?? null,
		createdAt: r.createdAt,
	}));
	// `outstanding` = the run produced promotable code but NO version has been pushed
	// to a GitHub PR yet → un-pushed work to promote before tearing the preview down.
	const outstanding = versions.length > 0 && versions.every((v) => !v.promotion);
	return json({ versions, outstanding });
};

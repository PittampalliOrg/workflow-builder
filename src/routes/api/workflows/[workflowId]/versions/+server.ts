/**
 * GET /api/workflows/[workflowId]/versions
 *
 * Cross-run "Versions" list: every `source-bundle` artifact across all executions
 * of this workflow (the durable, applyable code versions — see
 * docs/code-version-persistence.md). Each row carries its execution + node so the
 * UI can pair it with the same node's `diff` artifact for preview and offer a
 * Promote → PR action. Workspace-scoped.
 */

import { error, json } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import type { RequestHandler } from "./$types";
import { db } from "$lib/server/db";
import { workflows } from "$lib/server/db/schema";
import { assertInScope } from "$lib/server/workflows/project-scope";
import { listSourceBundlesForWorkflow } from "$lib/server/workflows/source-bundle";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!db) return error(503, "Database not configured");
	if (!locals.session?.userId) return error(401, "Authentication required");
	const { workflowId } = params;
	if (!workflowId) return error(400, "workflowId required");

	const [wf] = await db
		.select({ id: workflows.id, projectId: workflows.projectId, userId: workflows.userId })
		.from(workflows)
		.where(eq(workflows.id, workflowId))
		.limit(1);
	assertInScope(wf, locals.session, "Workflow not found");

	const rows = await listSourceBundlesForWorkflow(workflowId);
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
	return json({ versions });
};

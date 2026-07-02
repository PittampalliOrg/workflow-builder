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
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { assertInScope } from "$lib/server/workflows/project-scope";
import { evaluatePromotionGate } from "$lib/server/workflows/promotion-gates";
import { SOURCE_BUNDLE_KIND } from "$lib/server/workflows/source-bundle";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const { executionId } = params;
	if (!executionId) return error(400, "executionId required");

	const workflowData = getApplicationAdapters().workflowData;
	const exec = await workflowData.getExecutionById(executionId);
	assertInScope(exec, locals.session, "Execution not found");

	const rows = (await workflowData.listWorkflowArtifactsByExecutionId(executionId)).filter(
		(artifact) => artifact.kind === SOURCE_BUNDLE_KIND,
	);
	const versions = rows.map((r) => ({
		artifactId: r.id,
		executionId: r.workflowExecutionId,
		nodeId: r.nodeId,
		fileId: r.fileId,
		sizeBytes: r.sizeBytes,
		title: r.title,
		payload: r.inlinePayload,
		promotionGate: evaluatePromotionGate({
			mode: "pr",
			artifactPayload: r.inlinePayload,
			executionOutput: exec.output,
			summaryOutput: exec.summaryOutput,
		}),
		// Durable version→GitHub-PR status (set by promote); null = not yet pushed.
		promotion: (r.metadata as { promotion?: unknown } | null)?.promotion ?? null,
		createdAt: r.createdAt,
	}));
	// `outstanding` = the run produced promotable code but NO version has been pushed
	// to a GitHub PR yet → un-pushed work to promote before tearing the preview down.
	const outstanding = versions.length > 0 && versions.every((v) => !v.promotion);
	return json({ versions, outstanding });
};

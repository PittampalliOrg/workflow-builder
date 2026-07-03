import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import type { WorkflowExecutionControlResult } from '$lib/server/application/workflow-execution-control';

/**
 * POST /api/workflows/executions/[executionId]/resume
 *
 * Resume / fork a run from a NODE, skipping completed steps. This starts a FRESH
 * execution of the workflow's CURRENT (possibly edited) spec that SKIPS every
 * top-level node before `fromNodeId` and REUSES the source run's retained
 * /sandbox/work. (We deliberately do NOT use Dapr's rerun-from-event: that copies
 * the source's workflow input verbatim and cannot apply an edited spec.)
 *
 * Body: { fromNodeId? } — omit to auto-resume from the node in-flight when the run
 * stopped (the source run's currentNodeId). The forked run links to the source.
 *
 * Use cases: (1) fix the failed step and resume; (2) iterate on a later step
 * without re-running the expensive prefix. Edits to nodes BEFORE the resume point
 * do not take effect (those nodes are skipped + their workspace state is reused).
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	const { executionId } = params;
	if (!executionId) return error(400, 'executionId required');

	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	return workflowExecutionControlResponse(
		await getApplicationAdapters().workflowExecutionControl.resumeExecution({
			executionId,
			body,
			projectId: locals.session.projectId ?? null,
			userId: locals.session.userId
		})
	);
};

function workflowExecutionControlResponse(result: WorkflowExecutionControlResult) {
	if (result.status === 'error') return error(result.httpStatus, result.message);
	return json(result.body, { status: result.httpStatus ?? 200 });
}

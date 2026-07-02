import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import type { WorkflowDataService, WorkflowExecutionRecord } from '$lib/server/application/ports';
import { startWorkflowRun } from '$lib/server/workflows/start-run';
import { isResourceInScope } from '$lib/server/workflows/project-scope';
import { ownsBenchmarkOrEvalRun } from '$lib/server/lifecycle/ownership';

/**
 * The shared /sandbox/work workspace is keyed on `workspaceExecutionId`, which on a
 * normal run equals the run's Dapr instance id. A resume/fork must re-mount the
 * ORIGINAL run's workspace, so we thread the ROOT run's instance id (walk lineage).
 */
async function resolveWorkspaceExecutionId(
	workflowData: WorkflowDataService,
	source: WorkflowExecutionRecord,
): Promise<string | null> {
	let current = source;
	for (let hops = 0; hops < 20 && current?.rerunOfExecutionId; hops++) {
		const parent = await workflowData.getExecutionById(current.rerunOfExecutionId);
		if (!parent) break;
		current = parent;
	}
	return current.daprInstanceId;
}

/** Top-level node ids of a SW 1.0 spec, in order. */
function topLevelNodeIds(spec: unknown): string[] {
	const doList = (spec as { do?: unknown })?.do;
	if (!Array.isArray(doList)) return [];
	const ids: string[] = [];
	for (const entry of doList) {
		if (entry && typeof entry === 'object') {
			for (const k of Object.keys(entry as Record<string, unknown>)) ids.push(k);
		}
	}
	return ids;
}

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

	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	let fromNodeId =
		typeof body.fromNodeId === 'string' && body.fromNodeId.trim() ? body.fromNodeId.trim() : undefined;
	// Canvas node ids are "/do/<i>/<name>"; the orchestrator keys on the bare node
	// name, so accept either form by reducing to the last path segment.
	if (fromNodeId?.includes('/')) {
		fromNodeId = fromNodeId.split('/').filter(Boolean).pop() ?? fromNodeId;
	}

	// 1. Source run + scope.
	const workflowData = getApplicationAdapters().workflowData;
	const source = await workflowData.getExecutionById(params.executionId);
	if (!source) return error(404, 'Execution not found');
	if (!isResourceInScope(source, locals.session)) return error(404, 'Execution not found');
	if (!source.daprInstanceId) return error(409, 'Run has no Dapr instance id to resume from');

	// Single stop/resume authority: coordinator-driven benchmark/eval instances 409.
	const owner = await ownsBenchmarkOrEvalRun(params.executionId);
	if (owner) {
		return json(
			{
				ok: false,
				error: 'coordinator_owned',
				ownedBy: owner.kind,
				runId: owner.runId,
				message: 'This is a benchmark/eval instance — resume via the owning run instead.'
			},
			{ status: 409 }
		);
	}

	// 2. Current (possibly edited) workflow spec → validate the resume node exists.
	const workflow = await workflowData.getWorkflowByRef({ workflowId: source.workflowId, lookup: 'id' });
	if (!workflow) return error(404, 'Workflow not found');
	const nodeIds = topLevelNodeIds(workflow.spec);

	// Auto-locate: the node in-flight when the source run stopped.
	if (!fromNodeId) fromNodeId = source.currentNodeId ?? undefined;
	if (!fromNodeId) return error(400, 'Could not determine a resume node; pass fromNodeId');
	if (nodeIds.length && !nodeIds.includes(fromNodeId)) {
		return error(404, `Node '${fromNodeId}' is not a top-level node in the current workflow`);
	}

	// 3. Hermetic fork: the new run uses its OWN fresh workspace, SEEDED (copied) from
	// the source run's retained /sandbox/work — so repeated forks are isolated (no drift).
	const seedWorkspaceFrom = await resolveWorkspaceExecutionId(workflowData, source);

	// 4. Fresh execution of the CURRENT spec, skipping the prefix + seeding the workspace.
	const result = await startWorkflowRun({
		workflowId: source.workflowId,
		triggerData: (source.input ?? {}) as Record<string, unknown>,
		resumeFromNode: fromNodeId,
		seedWorkspaceFrom: seedWorkspaceFrom ?? undefined,
		rerunOfExecutionId: source.id,
		rerunSourceInstanceId: source.daprInstanceId,
		triggerSource: 'resume'
	});

	if (!result.ok) return error(result.status, result.error);

	return json({
		ok: true,
		executionId: result.executionId,
		sourceExecutionId: source.id,
		newInstanceId: result.instanceId,
		fromNodeId,
		seedWorkspaceFrom
	});
};

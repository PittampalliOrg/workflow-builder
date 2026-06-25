import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { workflows, workflowExecutions } from '$lib/server/db/schema';
import { startWorkflowRun } from '$lib/server/workflows/start-run';
import { isResourceInScope } from '$lib/server/workflows/project-scope';
import { ownsBenchmarkOrEvalRun } from '$lib/server/lifecycle/ownership';

type ExecutionRow = typeof workflowExecutions.$inferSelect;

/**
 * The shared /sandbox/work workspace is keyed on `workspaceExecutionId`, which on a
 * normal run equals the run's Dapr instance id. A resume/fork must re-mount the
 * ORIGINAL run's workspace, so we thread the ROOT run's instance id (walk lineage).
 */
async function resolveWorkspaceExecutionId(source: ExecutionRow): Promise<string | null> {
	let current = source;
	for (let hops = 0; hops < 20 && current?.rerunOfExecutionId; hops++) {
		const [parent] = await db!
			.select()
			.from(workflowExecutions)
			.where(eq(workflowExecutions.id, current.rerunOfExecutionId))
			.limit(1);
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
	if (!db) return error(503, 'Database not configured');

	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	let fromNodeId =
		typeof body.fromNodeId === 'string' && body.fromNodeId.trim() ? body.fromNodeId.trim() : undefined;

	// 1. Source run + scope.
	const [source] = await db
		.select()
		.from(workflowExecutions)
		.where(eq(workflowExecutions.id, params.executionId))
		.limit(1);
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
	const [workflow] = await db
		.select()
		.from(workflows)
		.where(eq(workflows.id, source.workflowId))
		.limit(1);
	if (!workflow) return error(404, 'Workflow not found');
	const nodeIds = topLevelNodeIds((workflow as Record<string, unknown>).spec);

	// Auto-locate: the node in-flight when the source run stopped.
	if (!fromNodeId) fromNodeId = source.currentNodeId ?? undefined;
	if (!fromNodeId) return error(400, 'Could not determine a resume node; pass fromNodeId');
	if (nodeIds.length && !nodeIds.includes(fromNodeId)) {
		return error(404, `Node '${fromNodeId}' is not a top-level node in the current workflow`);
	}

	// 3. Stable workspace key = the root run's instance id (re-mount its /sandbox/work).
	const workspaceExecutionId = await resolveWorkspaceExecutionId(source);

	// 4. Fresh execution of the CURRENT spec, skipping the prefix + reusing the workspace.
	const result = await startWorkflowRun({
		workflowId: source.workflowId,
		triggerData: (source.input ?? {}) as Record<string, unknown>,
		resumeFromNode: fromNodeId,
		workspaceExecutionId: workspaceExecutionId ?? undefined,
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
		workspaceExecutionId
	});
};

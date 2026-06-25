import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { workflows, workflowExecutions } from '$lib/server/db/schema';
import { daprFetch, getOrchestratorUrl } from '$lib/server/dapr-client';
import { AgentRefResolutionError, resolveSpecAgentRefs } from '$lib/server/agents/resolver';
import { isSWWorkflow } from '$lib/server/workflows/start-run';
import { isResourceInScope } from '$lib/server/workflows/project-scope';
import { ownsBenchmarkOrEvalRun } from '$lib/server/lifecycle/ownership';

type ExecutionRow = typeof workflowExecutions.$inferSelect;

/**
 * The shared /sandbox/work workspace is keyed on `workspaceExecutionId`, which on a
 * normal run equals the run's Dapr instance id. A resume must re-mount the ORIGINAL
 * run's workspace, so we thread the ROOT run's instance id (walk the rerun lineage).
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

/**
 * POST /api/workflows/executions/[executionId]/resume
 *
 * Resume a terminal/failed run from a NODE, skipping completed steps. Node-aware
 * wrapper over Dapr's native rerun-from-event: the completed prefix replays from the
 * source instance's history as cached results (validated: durable/run agent children
 * are NOT re-dispatched), and the resume node onward re-executes with the CURRENT
 * (edited) spec against the ORIGINAL run's retained /sandbox/work.
 *
 * Body: { fromNodeId? } — omit (or "__failed__") to auto-resume from the node that was
 * in-flight when the run stopped. Creates a NEW execution row linked to the source.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	if (!db) return error(503, 'Database not configured');

	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const fromNodeId =
		typeof body.fromNodeId === 'string' && body.fromNodeId.trim() ? body.fromNodeId.trim() : undefined;

	// 1. Source run + scope.
	const [source] = await db
		.select()
		.from(workflowExecutions)
		.where(eq(workflowExecutions.id, params.executionId))
		.limit(1);
	if (!source) return error(404, 'Execution not found');
	if (!isResourceInScope(source, locals.session)) return error(404, 'Execution not found');
	if (!source.daprInstanceId) {
		return error(409, 'Run has no Dapr instance id to resume from');
	}

	// Single stop/resume authority: a benchmark/eval instance is coordinator-driven —
	// don't resume it directly (mirrors the Stop route's coordinator_owned guard).
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

	// 2. Current (possibly edited) workflow spec.
	const [workflow] = await db
		.select()
		.from(workflows)
		.where(eq(workflows.id, source.workflowId))
		.limit(1);
	if (!workflow) return error(404, 'Workflow not found');
	let spec = (workflow as Record<string, unknown>).spec as Record<string, unknown> | null;
	if (!spec || !isSWWorkflow(spec)) {
		return error(400, 'Workflow does not have a runnable SW 1.0 spec');
	}

	const resumable = Boolean(
		((((spec as Record<string, unknown>).document as Record<string, unknown>) ?? {})[
			'x-workflow-builder'
		] as Record<string, unknown> | undefined)?.resumable
	);

	// 3. Reuse the source run's trigger inputs (the resume node sees the same trigger).
	const triggerData = (source.input ?? {}) as Record<string, unknown>;

	// 4. Resolve agent refs against the current spec (same as a normal start).
	try {
		spec = await resolveSpecAgentRefs(spec, { triggerData });
	} catch (err) {
		if (err instanceof AgentRefResolutionError) return error(400, err.message);
		throw err;
	}

	// 5. Stable workspace key = the root run's instance id (re-mount its /sandbox/work).
	const workspaceExecutionId = await resolveWorkspaceExecutionId(source);

	// 6. New execution row linked to the source (reuses the existing rerun lineage cols).
	const [execution] = await db
		.insert(workflowExecutions)
		.values({
			workflowId: source.workflowId,
			userId: source.userId,
			projectId: source.projectId,
			status: 'running',
			phase: 'running',
			progress: 0,
			input: triggerData,
			rerunOfExecutionId: source.id,
			rerunSourceInstanceId: source.daprInstanceId,
			triggerSource: 'resume'
		})
		.returning();

	// 7. Call the orchestrator node-aware resume (overwriteInput = the edited spec).
	const resumeInput = {
		workflow: spec,
		workflowId: source.workflowId,
		triggerData,
		dbExecutionId: execution.id,
		workspaceExecutionId
	};
	let res: Response;
	try {
		res = await daprFetch(
			`${getOrchestratorUrl()}/api/v2/workflows/${encodeURIComponent(source.daprInstanceId)}/resume`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					fromNodeId,
					input: resumeInput,
					reason: `Resume from ${fromNodeId ?? 'failed step'} (source ${source.id}) by ${locals.session.userId}`
				}),
				signal: AbortSignal.timeout(20_000)
			}
		);
	} catch (err) {
		await db
			.update(workflowExecutions)
			.set({
				status: 'error',
				phase: 'failed',
				error: err instanceof Error ? err.message : 'Failed to reach orchestrator',
				completedAt: new Date()
			})
			.where(eq(workflowExecutions.id, execution.id));
		return error(502, 'Failed to reach workflow orchestrator');
	}

	const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	if (!res.ok) {
		const detail =
			(typeof payload.detail === 'string' && payload.detail) ||
			(typeof payload.error === 'string' && payload.error) ||
			'Resume failed';
		await db
			.update(workflowExecutions)
			.set({ status: 'error', phase: 'failed', error: detail, completedAt: new Date() })
			.where(eq(workflowExecutions.id, execution.id));
		// Surface 404 (node not in run history) / 409 (no resumable boundaries) verbatim.
		return error(res.status, detail);
	}

	const newInstanceId = typeof payload.newInstanceId === 'string' ? payload.newInstanceId : null;
	const fromEventId = typeof payload.fromEventId === 'number' ? payload.fromEventId : null;
	const resolvedNode = typeof payload.fromNodeId === 'string' ? payload.fromNodeId : (fromNodeId ?? null);

	await db
		.update(workflowExecutions)
		.set({
			daprInstanceId: newInstanceId,
			rerunFromEventId: fromEventId ?? undefined,
			workflowSessionId: execution.id
		})
		.where(eq(workflowExecutions.id, execution.id));

	return json({
		ok: true,
		executionId: execution.id,
		sourceExecutionId: source.id,
		newInstanceId,
		fromNodeId: resolvedNode,
		fromEventId,
		resumable
	});
};

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import type { WorkflowPlanArtifactResult } from '$lib/server/application/workflow-plan';
import type { WorkflowPlanArtifactRecord } from '$lib/server/application/ports';

/**
 * GET /api/workflows/executions/[executionId]/plan-artifacts
 *
 * Returns all plan artifacts for the execution, ordered by creation time.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	const { executionId } = params;

	const result = await getApplicationAdapters().workflowPlan.listExecutionPlanArtifacts({
		executionId,
		userId: locals.session.userId,
		projectId: locals.session.projectId ?? null
	});

	if (result.status === 'not_found') return error(404, result.message);
	return json({ artifacts: result.artifacts.map(serializePlanArtifact) });
};

/**
 * POST /api/workflows/executions/[executionId]/plan-artifacts
 *
 * Create a new plan artifact for the execution.
 * Body: { goal, planMarkdown, planJson?, nodeId, workflowId, metadata? }
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	const { executionId } = params;

	const body = await request.json();

	const result = await getApplicationAdapters().workflowPlan.createExecutionPlanArtifact({
		executionId,
		userId: locals.session.userId,
		projectId: locals.session.projectId ?? null,
		...(isRecord(body) ? body : {})
	});

	return planArtifactResponse(result, 201);
};

/**
 * PATCH /api/workflows/executions/[executionId]/plan-artifacts
 *
 * Update a plan artifact's status (approve, reject, etc.)
 * Body: { artifactId, status, metadata? }
 */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	const { executionId } = params;
	const body = await request.json();

	const result = await getApplicationAdapters().workflowPlan.updateExecutionPlanArtifactStatus({
		executionId,
		userId: locals.session.userId,
		projectId: locals.session.projectId ?? null,
		...(isRecord(body) ? body : {})
	});

	return planArtifactResponse(result);
};

function serializePlanArtifact(artifact: WorkflowPlanArtifactRecord) {
	return {
		id: artifact.artifactRef,
		...artifact,
	};
}

function planArtifactResponse(
	result: WorkflowPlanArtifactResult,
	status = 200
) {
	if (result.status === 'bad_request') return error(400, result.message);
	if (result.status === 'not_found') return error(404, result.message);
	if (result.status === 'error') return error(500, result.message);
	return json(serializePlanArtifact(result.artifact), { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

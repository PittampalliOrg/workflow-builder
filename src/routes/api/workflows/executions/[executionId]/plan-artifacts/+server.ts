import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import {
	type WorkflowPlanArtifactRecord,
	type WorkflowPlanArtifactStatus
} from '$lib/server/application/ports';
import { generateId } from '$lib/server/utils/id';

/**
 * GET /api/workflows/executions/[executionId]/plan-artifacts
 *
 * Returns all plan artifacts for the execution, ordered by creation time.
 */
export const GET: RequestHandler = async ({ params }) => {
	const { executionId } = params;

	const artifacts = await getApplicationAdapters().workflowData.listPlanArtifactsByExecutionId(
		executionId,
	);

	return json({ artifacts: artifacts.map(serializePlanArtifact) });
};

/**
 * POST /api/workflows/executions/[executionId]/plan-artifacts
 *
 * Create a new plan artifact for the execution.
 * Body: { goal, planMarkdown, planJson?, nodeId, workflowId, metadata? }
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const { executionId } = params;

	const body = await request.json();
	const { goal, planMarkdown, planJson, nodeId, workflowId, metadata } = body;

	if (!goal || !nodeId || !workflowId) {
		return error(400, 'Missing required fields: goal, nodeId, workflowId');
	}

	const workflowData = getApplicationAdapters().workflowData;
	const artifactRef = generateId();
	await workflowData.upsertPlanArtifact({
		artifactRef,
		workflowExecutionId: executionId,
		workflowId,
		nodeId,
		goal,
		planMarkdown: planMarkdown || null,
		planJson: planJson || { steps: [] },
		status: 'draft' as WorkflowPlanArtifactStatus,
		metadata: metadata || null
	});
	const artifact = await workflowData.getPlanArtifact(artifactRef);
	if (!artifact) return error(500, 'Plan artifact was not created');

	return json(serializePlanArtifact(artifact), { status: 201 });
};

/**
 * PATCH /api/workflows/executions/[executionId]/plan-artifacts
 *
 * Update a plan artifact's status (approve, reject, etc.)
 * Body: { artifactId, status, metadata? }
 */
export const PATCH: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { artifactId, status, metadata } = body;

	if (!artifactId || !status) {
		return error(400, 'Missing required fields: artifactId, status');
	}

	const validStatuses: WorkflowPlanArtifactStatus[] = [
		'draft',
		'approved',
		'superseded',
		'executed',
		'failed'
	];
	if (!validStatuses.includes(status)) {
		return error(400, `Invalid status. Must be one of: ${validStatuses.join(', ')}`);
	}

	const workflowData = getApplicationAdapters().workflowData;
	await workflowData.updatePlanArtifactStatus({
		artifactRef: artifactId,
		status,
		metadata: metadata ?? undefined
	});
	const updated = await workflowData.getPlanArtifact(artifactId);

	if (!updated) {
		return error(404, 'Plan artifact not found');
	}

	return json(serializePlanArtifact(updated));
};

function serializePlanArtifact(artifact: WorkflowPlanArtifactRecord) {
	return {
		id: artifact.artifactRef,
		...artifact,
	};
}

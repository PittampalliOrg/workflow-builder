import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import {
	workflowPlanArtifacts,
	workflowExecutions,
	type WorkflowPlanArtifactStatus
} from '$lib/server/db/schema';
import { eq, desc } from 'drizzle-orm';

/**
 * GET /api/workflows/executions/[executionId]/plan-artifacts
 *
 * Returns all plan artifacts for the execution, ordered by creation time.
 */
export const GET: RequestHandler = async ({ params }) => {
	const { executionId } = params;

	if (!db) {
		return error(500, 'Database not available');
	}

	const artifacts = await db
		.select()
		.from(workflowPlanArtifacts)
		.where(eq(workflowPlanArtifacts.workflowExecutionId, executionId))
		.orderBy(desc(workflowPlanArtifacts.createdAt));

	return json({ artifacts });
};

/**
 * POST /api/workflows/executions/[executionId]/plan-artifacts
 *
 * Create a new plan artifact for the execution.
 * Body: { goal, planMarkdown, planJson?, nodeId, workflowId, metadata? }
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const { executionId } = params;

	if (!db) {
		return error(500, 'Database not available');
	}

	const body = await request.json();
	const { goal, planMarkdown, planJson, nodeId, workflowId, metadata } = body;

	if (!goal || !nodeId || !workflowId) {
		return error(400, 'Missing required fields: goal, nodeId, workflowId');
	}

	const [artifact] = await db
		.insert(workflowPlanArtifacts)
		.values({
			workflowExecutionId: executionId,
			workflowId,
			nodeId,
			goal: goal,
			planMarkdown: planMarkdown || null,
			planJson: planJson || { steps: [] },
			status: 'draft' as WorkflowPlanArtifactStatus,
			metadata: metadata || null
		})
		.returning();

	return json(artifact, { status: 201 });
};

/**
 * PATCH /api/workflows/executions/[executionId]/plan-artifacts
 *
 * Update a plan artifact's status (approve, reject, etc.)
 * Body: { artifactId, status, metadata? }
 */
export const PATCH: RequestHandler = async ({ params, request }) => {
	const { executionId } = params;

	if (!db) {
		return error(500, 'Database not available');
	}

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

	const [updated] = await db
		.update(workflowPlanArtifacts)
		.set({
			status,
			updatedAt: new Date(),
			...(metadata ? { metadata } : {})
		})
		.where(eq(workflowPlanArtifacts.id, artifactId))
		.returning();

	if (!updated) {
		return error(404, 'Plan artifact not found');
	}

	return json(updated);
};

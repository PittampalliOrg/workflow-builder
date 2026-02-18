import "server-only";

import { and, desc, eq, isNotNull, like } from "drizzle-orm";
import { db } from "./index";
import { workflowPlanArtifacts } from "./schema";

export type WorkflowPlanArtifactListItem = {
	id: string;
	goal: string;
	artifactType: string;
	status: string;
	workflowId: string;
	nodeId: string;
	createdAt: Date;
};

export type WorkflowExecutionPlanArtifact = {
	id: string;
	goal: string;
	status: string;
	artifactType: string;
	nodeId: string;
	planMarkdown: string | null;
	planJson: unknown;
	metadata: Record<string, unknown> | null;
	createdAt: Date;
	updatedAt: Date;
};

export async function listWorkflowPlanArtifactsForUser(input: {
	userId: string;
	searchValue?: string;
	workflowId?: string;
	limit?: number;
}): Promise<WorkflowPlanArtifactListItem[]> {
	const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
	const searchValue = input.searchValue?.trim();
	const workflowId = input.workflowId?.trim();
	const whereConditions = [
		eq(workflowPlanArtifacts.userId, input.userId),
		isNotNull(workflowPlanArtifacts.planJson),
	];
	if (searchValue && searchValue.length > 0) {
		whereConditions.push(like(workflowPlanArtifacts.goal, `%${searchValue}%`));
	}
	if (workflowId && workflowId.length > 0) {
		whereConditions.push(eq(workflowPlanArtifacts.workflowId, workflowId));
	}

	return await db
		.select({
			id: workflowPlanArtifacts.id,
			goal: workflowPlanArtifacts.goal,
			artifactType: workflowPlanArtifacts.artifactType,
			status: workflowPlanArtifacts.status,
			workflowId: workflowPlanArtifacts.workflowId,
			nodeId: workflowPlanArtifacts.nodeId,
			createdAt: workflowPlanArtifacts.createdAt,
		})
		.from(workflowPlanArtifacts)
		.where(
			whereConditions.length > 1 ? and(...whereConditions) : whereConditions[0],
		)
		.orderBy(desc(workflowPlanArtifacts.createdAt))
		.limit(limit);
}

export async function getLatestWorkflowPlanArtifactForExecution(input: {
	workflowExecutionId: string;
	nodeId?: string;
}): Promise<WorkflowExecutionPlanArtifact | null> {
	const executionId = input.workflowExecutionId.trim();
	if (!executionId) {
		return null;
	}
	const nodeId = input.nodeId?.trim();

	const whereConditions = [
		eq(workflowPlanArtifacts.workflowExecutionId, executionId),
	];
	if (nodeId) {
		whereConditions.push(eq(workflowPlanArtifacts.nodeId, nodeId));
	}

	const [row] = await db
		.select({
			id: workflowPlanArtifacts.id,
			goal: workflowPlanArtifacts.goal,
			status: workflowPlanArtifacts.status,
			artifactType: workflowPlanArtifacts.artifactType,
			nodeId: workflowPlanArtifacts.nodeId,
			planMarkdown: workflowPlanArtifacts.planMarkdown,
			planJson: workflowPlanArtifacts.planJson,
			metadata: workflowPlanArtifacts.metadata,
			createdAt: workflowPlanArtifacts.createdAt,
			updatedAt: workflowPlanArtifacts.updatedAt,
		})
		.from(workflowPlanArtifacts)
		.where(
			whereConditions.length > 1 ? and(...whereConditions) : whereConditions[0],
		)
		.orderBy(desc(workflowPlanArtifacts.createdAt))
		.limit(1);

	if (!row) {
		return null;
	}
	return {
		...row,
		metadata:
			row.metadata && typeof row.metadata === "object"
				? (row.metadata as Record<string, unknown>)
				: null,
	};
}

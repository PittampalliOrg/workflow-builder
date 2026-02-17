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

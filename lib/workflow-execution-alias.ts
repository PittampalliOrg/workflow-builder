import { eq, like, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowExecutions, workflowWorkspaceSessions } from "@/lib/db/schema";

export async function resolveWorkflowExecutionIdAlias(
	candidateExecutionId: string,
): Promise<string> {
	const candidate = candidateExecutionId.trim();
	if (!candidate) {
		return candidateExecutionId;
	}

	const [directMatch] = await db
		.select({ id: workflowExecutions.id })
		.from(workflowExecutions)
		.where(
			or(
				eq(workflowExecutions.id, candidate),
				eq(workflowExecutions.daprInstanceId, candidate),
			),
		)
		.limit(1);

	if (directMatch?.id) {
		return directMatch.id;
	}

	const workspaceRootPath = `/workspace/${candidate}`;
	const [workspaceMatch] = await db
		.select({
			workflowExecutionId: workflowWorkspaceSessions.workflowExecutionId,
		})
		.from(workflowWorkspaceSessions)
		.where(
			or(
				eq(workflowWorkspaceSessions.workspaceRef, candidate),
				eq(workflowWorkspaceSessions.durableInstanceId, candidate),
				eq(workflowWorkspaceSessions.rootPath, workspaceRootPath),
				like(workflowWorkspaceSessions.clonePath, `${workspaceRootPath}/%`),
			),
		)
		.limit(1);

	return workspaceMatch?.workflowExecutionId ?? candidateExecutionId;
}

import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { projects, workflowExecutions, workflows } from '$lib/server/db/schema';

export type ExecutionWorkspaceRoute = {
	projectId: string;
	userId: string;
	workspaceSlug: string;
};

export function buildRuntimePreviewPath(
	executionId: string,
	workspaceSlug: string,
	search = ''
): string {
	const normalizedSearch = search ? (search.startsWith('?') ? search : `?${search}`) : '';
	return `/workspaces/${encodeURIComponent(workspaceSlug)}/workflows/runtime-preview/${encodeURIComponent(executionId)}${normalizedSearch}`;
}

export async function getExecutionWorkspaceRoute(
	executionId: string
): Promise<ExecutionWorkspaceRoute | null> {
	if (!db) return null;

	const [execution] = await db
		.select({
			userId: workflowExecutions.userId,
			executionProjectId: workflowExecutions.projectId,
			workflowProjectId: workflows.projectId
		})
		.from(workflowExecutions)
		.leftJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
		.where(eq(workflowExecutions.id, executionId))
		.limit(1);

	const projectId = execution?.executionProjectId || execution?.workflowProjectId;
	if (!execution || !projectId) return null;

	const [project] = await db
		.select({ externalId: projects.externalId })
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1);

	return {
		projectId,
		userId: execution.userId,
		workspaceSlug: project?.externalId || projectId
	};
}

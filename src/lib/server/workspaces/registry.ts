import { getApplicationAdapters } from "$lib/server/application";
import type { WorkspaceSummary } from "$lib/server/application/ports";

export type { WorkspaceSummary };

export type ListWorkspacesInput = {
	userId: string;
	currentProjectId: string;
};

export type CreateWorkspaceInput = {
	displayName: string;
	externalId?: string;
	userId: string;
	platformId: string;
};

/**
 * Workspace registry is a route-facing facade. Business rules and persistence
 * live behind workflow-data so UI routes stay presentation adapters.
 */
export async function listWorkspaces(
	input: ListWorkspacesInput,
): Promise<WorkspaceSummary[]> {
	return getApplicationAdapters().workflowData.listWorkspaces(input);
}

export async function createWorkspace(
	input: CreateWorkspaceInput,
): Promise<WorkspaceSummary> {
	return getApplicationAdapters().workflowData.createWorkspace(input);
}

export async function renameWorkspace(
	projectId: string,
	userId: string,
	displayName: string,
): Promise<boolean> {
	return getApplicationAdapters().workflowData.renameWorkspace({
		projectId,
		userId,
		displayName,
	});
}

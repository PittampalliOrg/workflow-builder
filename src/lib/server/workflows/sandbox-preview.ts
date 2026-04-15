import { db } from '$lib/server/db';
import { workflowExecutions, workflowWorkspaceSessions } from '$lib/server/db/schema';
import { desc, eq } from 'drizzle-orm';

export interface ExecutionSandboxPreviewInfo {
	executionId: string;
	workspaceRef: string;
	sandboxName: string;
	rootPath: string;
	workingDir: string;
	provider: string;
	kept: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function asBoolean(value: unknown): boolean {
	if (typeof value === 'boolean') return value;
	if (typeof value === 'string') {
		const normalized = value.trim().toLowerCase();
		return normalized === 'true' || normalized === '1' || normalized === 'yes';
	}
	return false;
}

export async function getExecutionSandboxPreviewInfo(
	executionId: string
): Promise<ExecutionSandboxPreviewInfo | null> {
	if (!db) return null;

	const [execution] = await db
		.select({
			id: workflowExecutions.id,
			input: workflowExecutions.input,
			output: workflowExecutions.output
		})
		.from(workflowExecutions)
		.where(eq(workflowExecutions.id, executionId))
		.limit(1);

	if (!execution) return null;

	const [workspace] = await db
		.select({
			workspaceRef: workflowWorkspaceSessions.workspaceRef,
			rootPath: workflowWorkspaceSessions.rootPath,
			sandboxState: workflowWorkspaceSessions.sandboxState,
			status: workflowWorkspaceSessions.status
		})
		.from(workflowWorkspaceSessions)
		.where(eq(workflowWorkspaceSessions.workflowExecutionId, executionId))
		.orderBy(desc(workflowWorkspaceSessions.createdAt))
		.limit(1);

	const input = asRecord(execution.input);
	const output = asRecord(execution.output);
	const triggerData = asRecord(input?.triggerData);
	const workflowOutput = asRecord(output?.workflowOutput);
	const outputs = asRecord(output?.outputs);
	const initialize = asRecord(outputs?.initialize);
	const initializeData = asRecord(initialize?.data);

	const sandboxState = asRecord(workspace?.sandboxState);
	const workspaceDetails = asRecord(sandboxState?.details);
	const workspaceRef =
		asString(workspace?.workspaceRef) ||
		asString(workflowOutput?.sandboxWorkspaceRef) ||
		asString(initializeData?.sandbox_id);
	const sandboxName =
		asString(workspaceDetails?.sandboxName) ||
		asString(workspaceDetails?.name) ||
		asString(workflowOutput?.sandboxName) ||
		asString(initializeData?.sandbox_name);
	const rootPath =
		asString(workspace?.rootPath) ||
		asString(sandboxState?.rootPath) ||
		asString(workflowOutput?.sandboxRootPath) ||
		asString(initializeData?.root_path);
	const workingDir =
		asString(sandboxState?.workingDirectory) ||
		asString(workflowOutput?.sandboxWorkingDir) ||
		asString(initializeData?.working_dir) ||
		rootPath;
	const provider =
		asString(workspaceDetails?.provider) ||
		asString(workflowOutput?.sandboxProvider) ||
		asString(initializeData?.provider);
	const kept =
		workspace?.status === 'active' ||
		asBoolean(workflowOutput?.sandboxKept) ||
		asBoolean(triggerData?.keepSandbox) ||
		asBoolean(triggerData?.keep_sandbox) ||
		asBoolean(input?.keepSandbox) ||
		asBoolean(input?.keep_sandbox);

	if (!workspaceRef || !kept) return null;

	return {
		executionId,
		workspaceRef,
		sandboxName,
		rootPath,
		workingDir,
		provider,
		kept
	};
}

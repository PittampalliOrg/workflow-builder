import { db } from '$lib/server/db';
import { workflowExecutions } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

export interface ExecutionSandboxPreviewInfo {
	executionId: string;
	workspaceRef: string;
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

	const input = asRecord(execution.input);
	const output = asRecord(execution.output);
	const triggerData = asRecord(input?.triggerData);
	const workflowOutput = asRecord(output?.workflowOutput);
	const outputs = asRecord(output?.outputs);
	const initialize = asRecord(outputs?.initialize);
	const initializeData = asRecord(initialize?.data);

	const workspaceRef =
		asString(workflowOutput?.sandboxWorkspaceRef) ||
		asString(initializeData?.sandbox_id);
	const workingDir =
		asString(workflowOutput?.sandboxWorkingDir) ||
		asString(initializeData?.working_dir);
	const provider =
		asString(workflowOutput?.sandboxProvider) ||
		asString(initializeData?.provider);
	const kept =
		asBoolean(workflowOutput?.sandboxKept) ||
		asBoolean(triggerData?.keepSandbox) ||
		asBoolean(triggerData?.keep_sandbox) ||
		asBoolean(input?.keepSandbox) ||
		asBoolean(input?.keep_sandbox);

	if (!workspaceRef || !kept) return null;

	return {
		executionId,
		workspaceRef,
		workingDir,
		provider,
		kept
	};
}

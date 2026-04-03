import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { validateInternalToken } from '$lib/server/internal-auth';
import { db } from '$lib/server/db';
import { workflowExecutions, workflows } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { daprFetch, getOrchestratorUrl } from '$lib/server/dapr-client';

/**
 * GET /api/internal/agent/workflows/executions/[executionId]/status
 *
 * Returns execution status from DB + orchestrator runtime.
 * Security: Validated via X-Internal-Token header.
 */
export const GET: RequestHandler = async ({ request, params }) => {
	if (!validateInternalToken(request)) {
		return error(401, 'Unauthorized');
	}

	if (!db) {
		return error(503, 'Database not configured');
	}

	const { executionId } = params;

	const [execution] = await db
		.select()
		.from(workflowExecutions)
		.where(eq(workflowExecutions.id, executionId))
		.limit(1);

	if (!execution) {
		return error(404, 'Execution not found');
	}

	// Load associated workflow for orchestrator URL
	const [workflow] = await db
		.select({
			id: workflows.id,
			name: workflows.name,
			daprOrchestratorUrl: workflows.daprOrchestratorUrl,
			engineType: workflows.engineType
		})
		.from(workflows)
		.where(eq(workflows.id, execution.workflowId))
		.limit(1);

	// Query orchestrator for live runtime status
	let runtime: Record<string, unknown> | null = null;

	if (execution.daprInstanceId) {
		try {
			const orchestratorUrl =
				workflow?.daprOrchestratorUrl || getOrchestratorUrl();
			const res = await daprFetch(
				`${orchestratorUrl}/api/v2/workflows/${execution.daprInstanceId}/status`
			);
			if (res.ok) {
				runtime = await res.json();
			}
		} catch {
			// Orchestrator not reachable - return DB-only status
		}
	}

	// Map runtime status to local status
	let effectiveStatus = execution.status;
	let effectiveError = execution.error;

	if (runtime) {
		const runtimeStatus = (runtime.runtimeStatus as string) || '';
		effectiveStatus = mapRuntimeStatus(runtimeStatus, execution.status);
		if (runtime.error) {
			effectiveError = String(runtime.error);
		}

		// Sync DB if status diverged
		const shouldComplete =
			effectiveStatus === 'success' ||
			effectiveStatus === 'error' ||
			effectiveStatus === 'cancelled';

		if (
			effectiveStatus !== execution.status ||
			(runtime.phase as string | null) !== execution.phase ||
			(runtime.progress as number | null) !== execution.progress
		) {
			await db
				.update(workflowExecutions)
				.set({
					status: effectiveStatus,
					phase: (runtime.phase as string) ?? execution.phase,
					progress: (runtime.progress as number) ?? execution.progress,
					output:
						(runtime.outputs as Record<string, unknown>) ?? execution.output,
					error: effectiveError,
					...(shouldComplete && !execution.completedAt
						? { completedAt: new Date() }
						: {})
				})
				.where(eq(workflowExecutions.id, execution.id));
		}
	}

	return json({
		success: true,
		execution: {
			id: execution.id,
			workflowId: execution.workflowId,
			userId: execution.userId,
			status: effectiveStatus,
			phase: execution.phase,
			progress: execution.progress,
			error: effectiveError,
			input: execution.input,
			output: execution.output,
			daprInstanceId: execution.daprInstanceId,
			startedAt: execution.startedAt?.toISOString() ?? null,
			completedAt: execution.completedAt?.toISOString() ?? null,
			workflow: workflow
				? {
						id: workflow.id,
						name: workflow.name,
						daprOrchestratorUrl: workflow.daprOrchestratorUrl,
						engineType: workflow.engineType
					}
				: null
		},
		runtime,
		status: effectiveStatus,
		error: effectiveError
	});
};

function mapRuntimeStatus(
	runtimeStatus: string,
	fallback: string
): 'pending' | 'running' | 'success' | 'error' | 'cancelled' {
	switch (runtimeStatus.toUpperCase()) {
		case 'COMPLETED':
			return 'success';
		case 'FAILED':
			return 'error';
		case 'TERMINATED':
		case 'CANCELED':
			return 'cancelled';
		case 'PENDING':
			return 'pending';
		case 'RUNNING':
		case 'SUSPENDED':
			return 'running';
		default:
			return (fallback as 'pending' | 'running' | 'success' | 'error' | 'cancelled') || 'running';
	}
}

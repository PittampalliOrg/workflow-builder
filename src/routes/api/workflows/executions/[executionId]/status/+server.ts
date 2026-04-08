import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	loadExecutionReadModel,
	serializeExecutionReadModel
} from '$lib/server/execution-read-model';
import { daprFetch, getOrchestratorUrl } from '$lib/server/dapr-client';

/**
 * GET /api/workflows/executions/[executionId]/status
 *
 * Returns the execution read model using the same shaping logic as the
 * realtime stream endpoint. This keeps the legacy status route aligned with
 * the new SSE-backed run page.
 */
export const GET: RequestHandler = async ({ params }) => {
	const { executionId } = params;

	try {
		const model = await loadExecutionReadModel(executionId, {
			refreshRuntime: true,
			includeAgentEvents: false
		});

		if (model) {
			return json(
				serializeExecutionReadModel(model, {
					compact: false,
					includeAgentEvents: false
				})
			);
		}
	} catch (readModelError) {
		console.error('[ExecutionStatus] execution read-model load failed:', readModelError);
		return error(
			503,
			readModelError instanceof Error
				? readModelError.message
				: 'Execution read-model migration is required'
		);
	}

	const orchestratorUrl = getOrchestratorUrl();
	const response = await daprFetch(`${orchestratorUrl}/api/v2/workflows/${executionId}/status`);

	if (!response.ok) {
		return error(404, 'Execution not found');
	}

	const status = (await response.json()) as Record<string, unknown>;

	return json({
		executionId,
		instanceId: typeof status.instanceId === 'string' ? status.instanceId : executionId,
		workflowId: typeof status.workflowId === 'string' ? status.workflowId : null,
		status: mapRuntimeStatus(
			typeof status.runtimeStatus === 'string'
				? status.runtimeStatus
				: typeof status.status === 'string'
					? status.status
					: 'UNKNOWN'
		),
		runtimeStatus: typeof status.runtimeStatus === 'string' ? status.runtimeStatus : null,
		phase: typeof status.phase === 'string' ? status.phase : null,
		progress: typeof status.progress === 'number' ? status.progress : null,
		currentNodeId: typeof status.currentNodeId === 'string' ? status.currentNodeId : null,
		currentNodeName:
			typeof status.currentNodeName === 'string' ? status.currentNodeName : null,
		nodeStatuses: Array.isArray(status.nodeStatuses) ? status.nodeStatuses : [],
		traceId: typeof status.traceId === 'string' ? status.traceId : null,
		traceIds: typeof status.traceId === 'string' ? [status.traceId] : [],
		sessionId: null,
		input: null,
		output: status.outputs ?? null,
		summaryOutput: null,
		error: typeof status.error === 'string' ? status.error : null,
		startedAt: typeof status.startedAt === 'string' ? status.startedAt : null,
		completedAt: typeof status.completedAt === 'string' ? status.completedAt : null,
		steps: [],
		browserArtifacts: [],
		agentEvents: [],
		lastAgentEventId: 0
	});
};

function mapRuntimeStatus(
	runtimeStatus: string
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
		case 'SUSPENDED':
		default:
			return 'running';
	}
}

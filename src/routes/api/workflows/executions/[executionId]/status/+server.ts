import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { daprFetch, getOrchestratorUrl } from '$lib/server/dapr-client';
import { db } from '$lib/server/db';
import { workflowExecutions } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { extractExecutionTraceIds, findCorrelatedTraceIds } from '$lib/server/otel/clickhouse';

/**
 * GET /api/workflows/executions/[executionId]/status
 *
 * Returns execution status. First checks the DB execution record,
 * then optionally queries the orchestrator for live Dapr status.
 */
export const GET: RequestHandler = async ({ params }) => {
	const { executionId } = params;

	// Try DB first for the execution record
	if (db) {
		const [execution] = await db
			.select()
			.from(workflowExecutions)
			.where(eq(workflowExecutions.id, executionId))
			.limit(1);

		if (execution) {
			let liveStatus = null;

			// Always query orchestrator when we have a Dapr instance ID
			// (needed for traceId even after completion)
			if (execution.daprInstanceId) {
				try {
					const orchestratorUrl = getOrchestratorUrl();
					const res = await daprFetch(
						`${orchestratorUrl}/api/v2/workflows/${execution.daprInstanceId}/status`
					);
					if (res.ok) {
						liveStatus = await res.json();
					}
				} catch {
					// Orchestrator not reachable — return DB status
				}
			}

			// Extract per-step outputs and traceId from DB output
			const dbOutput = execution.output as Record<string, unknown> | null;
			const stepOutputs = dbOutput?.outputs as Record<string, unknown> | undefined;
			const dbTraceId = (dbOutput as Record<string, unknown>)?.traceId as string | undefined;
			const allTraceIds = extractExecutionTraceIds(execution.output);

			// Parse step outputs into normalized steps array
			const steps = stepOutputs
				? Object.entries(stepOutputs).map(([name, val]) => {
						const v = val as Record<string, unknown>;
						const d = v.data as Record<string, unknown> | undefined;
						return {
							stepName: name,
							label: (v.label as string) || name,
							actionType: (v.actionType as string) || '',
							status: d?.success === false || d?.error ? 'error' : d?.success === true ? 'success' : 'unknown',
							durationMs: (d?.duration_ms as number) ?? null,
							error: (d?.error as string) ?? null,
							data: d ?? null
						};
					})
				: [];

			// Merge live traceId into allTraceIds if present
			if (liveStatus?.traceId && !allTraceIds.includes(liveStatus.traceId)) {
				allTraceIds.unshift(liveStatus.traceId);
			}

			// For completed executions, also find correlated traces by time window
			// (dapr-swe, function-router don't propagate trace context through Dapr boundaries)
			if (execution.startedAt && (execution.status === 'success' || execution.status === 'error')) {
				const correlated = await findCorrelatedTraceIds(
					execution.startedAt,
					execution.completedAt,
					allTraceIds
				);
				for (const id of correlated) {
					if (!allTraceIds.includes(id)) allTraceIds.push(id);
				}
			}

			return json({
				executionId: execution.id,
				instanceId: execution.daprInstanceId,
				workflowId: execution.workflowId,
				status: execution.status,
				phase: (execution as Record<string, unknown>).phase ?? null,
				progress: (execution as Record<string, unknown>).progress ?? null,
				input: execution.input,
				output: execution.output,
				steps,
				startedAt: execution.startedAt?.toISOString() ?? null,
				completedAt: execution.completedAt?.toISOString() ?? null,
				traceIds: allTraceIds,
				// Merge live status if available
				...(liveStatus
					? {
							runtimeStatus: liveStatus.runtimeStatus,
							currentNodeId: liveStatus.currentNodeId ?? null,
							currentNodeName: liveStatus.currentNodeName ?? null,
							nodeStatuses: liveStatus.nodeStatuses ?? [],
							traceId: liveStatus.traceId ?? null,
							outputs: liveStatus.outputs ?? null
						}
					: {
							traceId: dbTraceId ?? null,
							outputs: stepOutputs ?? null
						})
			});
		}
	}

	// Fallback: try orchestrator directly with executionId as instanceId
	const orchestratorUrl = getOrchestratorUrl();
	const response = await daprFetch(`${orchestratorUrl}/api/v2/workflows/${executionId}/status`);

	if (!response.ok) {
		return error(404, 'Execution not found');
	}

	const status = await response.json();

	return json({
		executionId,
		instanceId: status.instanceId ?? executionId,
		workflowId: status.workflowId ?? null,
		status: mapRuntimeStatus(status.runtimeStatus ?? status.status ?? 'UNKNOWN'),
		runtimeStatus: status.runtimeStatus ?? null,
		phase: status.phase ?? null,
		progress: status.progress ?? null,
		currentNodeId: status.currentNodeId ?? null,
		currentNodeName: status.currentNodeName ?? null,
		nodeStatuses: status.nodeStatuses ?? [],
		traceId: status.traceId ?? null,
		outputs: status.outputs ?? null,
		error: status.error ?? null,
		startedAt: status.startedAt ?? null,
		completedAt: status.completedAt ?? null
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

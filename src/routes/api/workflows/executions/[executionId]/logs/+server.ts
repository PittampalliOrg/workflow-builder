import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { workflowExecutions, workflowExecutionLogs, workflowAgentEvents } from '$lib/server/db/schema';
import { eq, asc } from 'drizzle-orm';
import { extractExecutionTraceIds } from '$lib/server/otel/clickhouse';

export interface NormalizedLog {
	stepName: string;
	label: string;
	actionType: string;
	status: 'success' | 'error' | 'running' | 'pending' | 'unknown';
	input: unknown;
	output: unknown;
	error: string | null;
	durationMs: number | null;
}

/**
 * GET /api/workflows/executions/[executionId]/logs
 *
 * Returns normalized per-step logs for the execution.
 * Sources: workflowExecutionLogs table, then falls back to output.outputs from the execution record.
 */
export const GET: RequestHandler = async ({ params }) => {
	const { executionId } = params;

	if (!db) {
		return error(500, 'Database not available');
	}

	// Fetch the execution record
	const [execution] = await db
		.select()
		.from(workflowExecutions)
		.where(eq(workflowExecutions.id, executionId))
		.limit(1);

	if (!execution) {
		return error(404, 'Execution not found');
	}

	// Try workflowExecutionLogs table first
	const dbLogs = await db
		.select()
		.from(workflowExecutionLogs)
		.where(eq(workflowExecutionLogs.executionId, executionId))
		.orderBy(workflowExecutionLogs.startedAt);

	let logs: NormalizedLog[];

	if (dbLogs.length > 0) {
		logs = dbLogs.map((log) => ({
			stepName: log.nodeId,
			label: log.nodeName,
			actionType: log.activityName ?? log.nodeType,
			status: log.status === 'success' || log.status === 'error' || log.status === 'running' || log.status === 'pending'
				? log.status
				: 'unknown',
			input: log.input,
			output: log.output,
			error: log.error,
			durationMs: log.duration ? parseInt(log.duration, 10) : null
		}));
	} else {
		// Fallback: parse from execution output.outputs
		const execOutput = execution.output as Record<string, unknown> | null;
		const stepOutputs = execOutput?.outputs as Record<string, unknown> | undefined;

		logs = stepOutputs
			? Object.entries(stepOutputs).map(([name, val]) => {
					const v = val as Record<string, unknown>;
					const d = v.data as Record<string, unknown> | undefined;
					return {
						stepName: name,
						label: (v.label as string) || name,
						actionType: (v.actionType as string) || '',
						status: (d?.success === false || d?.error
							? 'error'
							: d?.success === true
								? 'success'
								: 'unknown') as NormalizedLog['status'],
						input: d?.input ?? null,
						output: d?.output ?? d ?? null,
						error: (d?.error as string) ?? null,
						durationMs: (d?.duration_ms as number) ?? null
					};
				})
			: [];
	}

	// Deduplicate by stepName (keep first occurrence)
	const seen = new Set<string>();
	logs = logs.filter((log) => {
		if (seen.has(log.stepName)) return false;
		seen.add(log.stepName);
		return true;
	});

	// Filter out virtual steps (trigger, state) that aren't real workflow nodes
	logs = logs.filter((log) => !['trigger', 'state'].includes(log.stepName));

	// Extract all traceIds from output (recursive extraction like Next.js app)
	const execOutput = execution.output as Record<string, unknown> | null;
	const traceId = (execOutput?.traceId as string) ?? null;
	const allTraceIds = extractExecutionTraceIds(execution.output);

	// Fetch agent events for this execution
	const agentEvents = await db
		.select({
			id: workflowAgentEvents.eventId,
			type: workflowAgentEvents.eventType,
			sourceEventId: workflowAgentEvents.sourceEventId,
			workflowAgentRunId: workflowAgentEvents.workflowAgentRunId,
			daprInstanceId: workflowAgentEvents.daprInstanceId,
			toolName: workflowAgentEvents.toolName,
			phase: workflowAgentEvents.phase,
			data: workflowAgentEvents.payload,
			timestamp: workflowAgentEvents.ts,
		})
		.from(workflowAgentEvents)
		.where(eq(workflowAgentEvents.workflowExecutionId, executionId))
		.orderBy(asc(workflowAgentEvents.eventId));

	return json({
		logs,
		agentEvents: agentEvents.map(e => ({
			id: e.id,
			type: e.type,
			sourceEventId: e.sourceEventId,
			workflowAgentRunId: e.workflowAgentRunId,
			daprInstanceId: e.daprInstanceId,
			toolName: e.toolName,
			phase: e.phase,
			data: e.data ?? {},
			timestamp: e.timestamp?.toISOString() ?? '',
		})),
		traceId,
		traceIds: allTraceIds,
		executionStatus: execution.status,
		input: execution.input,
		output: execution.output
	});
};

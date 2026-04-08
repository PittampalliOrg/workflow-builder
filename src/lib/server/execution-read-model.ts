import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { assertExecutionReadModelColumns } from '$lib/server/db/execution-read-model-support';
import {
	workflowAgentEvents,
	workflowExecutionLogs,
	workflowExecutions
} from '$lib/server/db/schema';
import { listBrowserArtifactsByExecutionId } from '$lib/server/browser-artifacts';
import { daprFetch, getOrchestratorUrl } from '$lib/server/dapr-client';
import { extractExecutionTraceIds } from '$lib/server/otel/clickhouse';
import type {
	ExecutionReadModel,
	ExecutionStepLog,
	ExecutionTimelineEvent
} from '$lib/types/execution-stream';

type ExecutionStatus = ExecutionReadModel['status'];

type ExecutionRow = typeof workflowExecutions.$inferSelect;

type LiveRuntimeStatus = {
	runtimeStatus: string | null;
	phase: string | null;
	progress: number | null;
	currentNodeId: string | null;
	currentNodeName: string | null;
	traceId: string | null;
	outputs: unknown;
	error: string | null;
	completedAt: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mapRuntimeStatus(
	runtimeStatus: string | null | undefined,
	fallback: ExecutionStatus
): ExecutionStatus {
	switch ((runtimeStatus ?? '').toUpperCase()) {
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
			return fallback;
	}
}

function normalizeEventType(type: string): string {
	switch (type) {
		case 'tool_start':
			return 'tool_call_start';
		case 'tool_complete':
			return 'tool_call_end';
		case 'tool_error':
			return 'tool_call_error';
		case 'model_start':
			return 'llm_start';
		case 'model_complete':
			return 'llm_complete';
		case 'sandbox_output_partial':
			return 'sandbox_output';
		case 'sandbox_heartbeat':
			return 'heartbeat';
		default:
			return type;
	}
}

function toIso(value: Date | string | null | undefined): string | null {
	if (!value) return null;
	if (value instanceof Date) return value.toISOString();
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function parseDurationMs(value: string | null): number | null {
	if (typeof value !== 'string' || !value.trim()) return null;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : null;
}

function buildNodeStatuses(
	steps: ExecutionStepLog[],
	currentNodeId: string | null,
	currentNodeName: string | null,
	status: ExecutionStatus
) {
	const nodeStatuses: Record<string, string> = {};
	for (const step of steps) {
		nodeStatuses[step.stepName] = step.status;
	}

	const activeNode = currentNodeId || currentNodeName;
	if (activeNode && (status === 'running' || status === 'pending')) {
		nodeStatuses[activeNode] = 'running';
	}

	return nodeStatuses;
}

async function fetchRecentAgentEvents(
	executionId: string,
	limit = 200
): Promise<ExecutionTimelineEvent[]> {
	if (!db) return [];

	const rows = await db
		.select()
		.from(workflowAgentEvents)
		.where(eq(workflowAgentEvents.workflowExecutionId, executionId))
		.orderBy(desc(workflowAgentEvents.eventId))
		.limit(limit);

	return rows
		.reverse()
		.map((row) => mapAgentEvent(row));
}

function mapAgentEvent(row: typeof workflowAgentEvents.$inferSelect): ExecutionTimelineEvent {
	const payload = isRecord(row.payload) ? row.payload : {};
	const data = isRecord(payload.data) ? payload.data : payload;
	if (row.phase && data.phase == null) data.phase = row.phase;
	if (row.toolName && data.toolName == null) data.toolName = row.toolName;
	if (row.traceId && data.traceId == null) data.traceId = row.traceId;

	const timestamp =
		typeof payload.ts === 'string'
			? payload.ts
			: typeof payload.timestamp === 'string'
				? payload.timestamp
				: row.ts.toISOString();

	return {
		id: row.eventId,
		type: normalizeEventType(row.eventType),
		data,
		timestamp
	};
}

export async function listExecutionAgentEvents(
	executionId: string,
	afterEventId: number
): Promise<ExecutionTimelineEvent[]> {
	if (!db) return [];

	const rows = await db
		.select()
		.from(workflowAgentEvents)
		.where(
			and(
				eq(workflowAgentEvents.workflowExecutionId, executionId),
				gt(workflowAgentEvents.eventId, afterEventId)
			)
		)
		.orderBy(asc(workflowAgentEvents.eventId));

	return rows.map((row) => mapAgentEvent(row));
}

async function refreshExecutionRuntime(execution: ExecutionRow): Promise<LiveRuntimeStatus | null> {
	if (!execution.daprInstanceId) return null;
	if (execution.status !== 'running' && execution.status !== 'pending') return null;

	try {
		const orchestratorUrl = getOrchestratorUrl();
		const res = await daprFetch(
			`${orchestratorUrl}/api/v2/workflows/${execution.daprInstanceId}/status`,
			{ method: 'GET', maxRetries: 1 }
		);
		if (!res.ok) return null;

		const runtime = (await res.json()) as Record<string, unknown>;
		const nextStatus = mapRuntimeStatus(
			typeof runtime.runtimeStatus === 'string' ? runtime.runtimeStatus : null,
			execution.status
		);
		const nextCompletedAt =
			typeof runtime.completedAt === 'string'
				? new Date(runtime.completedAt)
				: patchStatusIsTerminal(nextStatus) && !execution.completedAt
					? new Date()
					: execution.completedAt;
		const patch = {
			status: nextStatus,
			phase: typeof runtime.phase === 'string' ? runtime.phase : execution.phase,
			progress: typeof runtime.progress === 'number' ? runtime.progress : execution.progress,
			currentNodeId:
				typeof runtime.currentNodeId === 'string' ? runtime.currentNodeId : execution.currentNodeId,
			currentNodeName:
				typeof runtime.currentNodeName === 'string'
					? runtime.currentNodeName
					: execution.currentNodeName,
			primaryTraceId:
				typeof runtime.traceId === 'string' ? runtime.traceId : execution.primaryTraceId,
			error: typeof runtime.error === 'string' ? runtime.error : execution.error,
			completedAt: nextCompletedAt
		};

		const changed =
			patch.status !== execution.status ||
			patch.phase !== execution.phase ||
			patch.progress !== execution.progress ||
			patch.currentNodeId !== execution.currentNodeId ||
			patch.currentNodeName !== execution.currentNodeName ||
			patch.primaryTraceId !== execution.primaryTraceId ||
			patch.error !== execution.error ||
			(toIso(patch.completedAt) ?? null) !== toIso(execution.completedAt);

		if (changed && db) {
			await db
				.update(workflowExecutions)
				.set({
					status: patch.status,
					phase: patch.phase,
					progress: patch.progress,
					currentNodeId: patch.currentNodeId,
					currentNodeName: patch.currentNodeName,
					primaryTraceId: patch.primaryTraceId,
					error: patch.error,
					completedAt: patch.completedAt
				})
				.where(eq(workflowExecutions.id, execution.id));
		}

		return {
			runtimeStatus:
				typeof runtime.runtimeStatus === 'string' ? runtime.runtimeStatus : null,
			phase: typeof runtime.phase === 'string' ? runtime.phase : null,
			progress: typeof runtime.progress === 'number' ? runtime.progress : null,
			currentNodeId:
				typeof runtime.currentNodeId === 'string' ? runtime.currentNodeId : null,
			currentNodeName:
				typeof runtime.currentNodeName === 'string' ? runtime.currentNodeName : null,
			traceId: typeof runtime.traceId === 'string' ? runtime.traceId : null,
			outputs: runtime.outputs ?? null,
			error: typeof runtime.error === 'string' ? runtime.error : null,
			completedAt:
				typeof runtime.completedAt === 'string' ? runtime.completedAt : null
		};
	} catch {
		return null;
	}
}

function patchStatusIsTerminal(status: ExecutionStatus) {
	return status === 'success' || status === 'error' || status === 'cancelled';
}

async function readExecutionRow(executionId: string) {
	if (!db) return null;
	await assertExecutionReadModelColumns();
	const [execution] = await db
		.select()
		.from(workflowExecutions)
		.where(eq(workflowExecutions.id, executionId))
		.limit(1);
	return (execution as ExecutionRow | undefined) ?? null;
}

async function readExecutionSteps(executionId: string): Promise<ExecutionStepLog[]> {
	if (!db) return [];
	const rows = await db
		.select()
		.from(workflowExecutionLogs)
		.where(eq(workflowExecutionLogs.executionId, executionId))
		.orderBy(asc(workflowExecutionLogs.startedAt));

	return rows
		.filter((row) => !['trigger', 'state'].includes(row.nodeId))
		.map((row) => ({
			stepName: row.nodeId,
			label: row.nodeName,
			actionType: row.activityName ?? row.nodeType,
			status:
				row.status === 'success' ||
				row.status === 'error' ||
				row.status === 'running' ||
				row.status === 'pending'
					? row.status
					: 'unknown',
			input: row.input,
			output: row.output,
			error: row.error,
			durationMs: parseDurationMs(row.duration),
			startedAt: toIso(row.startedAt),
			completedAt: toIso(row.completedAt)
		}));
}

async function readTraceIds(execution: ExecutionRow) {
	const traceIds = new Set<string>();
	if (execution.primaryTraceId?.trim()) traceIds.add(execution.primaryTraceId.trim());
	for (const traceId of extractExecutionTraceIds(execution.output)) {
		traceIds.add(traceId);
	}

	if (db) {
		const rows = await db
			.select({ traceId: workflowAgentEvents.traceId })
			.from(workflowAgentEvents)
			.where(eq(workflowAgentEvents.workflowExecutionId, execution.id))
			.orderBy(desc(workflowAgentEvents.eventId))
			.limit(200);

		for (const row of rows) {
			if (typeof row.traceId === 'string' && row.traceId.trim()) {
				traceIds.add(row.traceId.trim());
			}
		}
	}

	return Array.from(traceIds);
}

export async function loadExecutionReadModel(
	executionId: string,
	options?: { refreshRuntime?: boolean; includeAgentEvents?: boolean }
): Promise<ExecutionReadModel | null> {
	if (!db) return null;

	let execution = await readExecutionRow(executionId);
	if (!execution) return null;

	const runtime =
		options?.refreshRuntime !== false ? await refreshExecutionRuntime(execution) : null;
	if (runtime) {
		execution = (await readExecutionRow(executionId)) ?? execution;
	}

	const [steps, browserArtifacts, agentEvents, traceIds] = await Promise.all([
		readExecutionSteps(executionId),
		listBrowserArtifactsByExecutionId(executionId),
		options?.includeAgentEvents === false ? Promise.resolve([]) : fetchRecentAgentEvents(executionId),
		readTraceIds(execution)
	]);

	const lastAgentEventId =
		agentEvents.at(-1)?.id ?? execution.lastAgentEventId ?? 0;
	const runtimeStatus = runtime?.runtimeStatus ?? null;
	const traceId = runtime?.traceId ?? execution.primaryTraceId ?? traceIds[0] ?? null;
	const output = execution.output ?? runtime?.outputs ?? null;
	const nodeStatuses = buildNodeStatuses(
		steps,
		execution.currentNodeId,
		execution.currentNodeName,
		execution.status
	);

	return {
		executionId: execution.id,
		workflowId: execution.workflowId,
		instanceId: execution.daprInstanceId,
		status: execution.status,
		runtimeStatus,
		phase: execution.phase,
		progress: execution.progress,
		currentNodeId: execution.currentNodeId,
		currentNodeName: execution.currentNodeName,
		traceId,
		traceIds,
		sessionId: execution.workflowSessionId,
		input: (execution.input as Record<string, unknown> | null) ?? null,
		output,
		summaryOutput: (execution.summaryOutput as Record<string, unknown> | null) ?? null,
		error: runtime?.error ?? execution.error,
		startedAt: toIso(execution.startedAt),
		completedAt: toIso(execution.completedAt) ?? runtime?.completedAt ?? null,
		nodeStatuses,
		steps,
		browserArtifacts,
		agentEvents,
		lastAgentEventId
	};
}

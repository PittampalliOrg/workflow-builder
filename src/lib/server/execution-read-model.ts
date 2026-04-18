import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { assertExecutionReadModelColumns } from '$lib/server/db/execution-read-model-support';
import {
	sessionEvents,
	sessions,
	workflowAgentRuns,
	workflowExecutionLogs,
	workflowExecutions,
	workflowWorkspaceSessions
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

/**
 * Phase 4 Step 2: read the execution timeline from `session_events` via the
 * `sessions.workflow_execution_id` join. Every `durable/run` node now spawns
 * a session (via the workflow↔session bridge), and that session's events are
 * the authoritative agent activity log. `workflow_agent_events` is still
 * written in parallel during the transition period but no longer read here.
 */
async function fetchRecentAgentEvents(
	executionId: string,
	limit = 200
): Promise<ExecutionTimelineEvent[]> {
	if (!db) return [];

	const rows = await db
		.select({
			id: sessionEvents.id,
			sequence: sessionEvents.sequence,
			sessionId: sessionEvents.sessionId,
			type: sessionEvents.type,
			data: sessionEvents.data,
			sourceEventId: sessionEvents.sourceEventId,
			createdAt: sessionEvents.createdAt
		})
		.from(sessionEvents)
		.innerJoin(sessions, eq(sessions.id, sessionEvents.sessionId))
		.where(eq(sessions.workflowExecutionId, executionId))
		.orderBy(desc(sessionEvents.sequence))
		.limit(limit);

	return rows.reverse().map((row) => mapSessionAgentEvent(row));
}

type SessionEventRow = {
	id: string;
	sequence: number;
	sessionId: string;
	type: string;
	data: unknown;
	sourceEventId: string | null;
	createdAt: Date;
};

function mapSessionAgentEvent(row: SessionEventRow): ExecutionTimelineEvent {
	const data = isRecord(row.data) ? { ...row.data } : {};
	const toolName =
		typeof data.tool_name === 'string'
			? data.tool_name
			: typeof data.toolName === 'string'
				? data.toolName
				: typeof data.name === 'string'
					? data.name
					: null;
	const phase = typeof data.phase === 'string' ? data.phase : null;
	// For sessions-bridged runs, workflow_agent_runs.id === sessions.id ===
	// dapr_instance_id. Stamping both linking fields with the session id so
	// the client-side eventsForAgentRun() filter matches on either.
	return {
		id: row.sequence,
		type: row.type,
		data,
		timestamp: row.createdAt.toISOString(),
		workflowAgentRunId: row.sessionId,
		daprInstanceId: row.sessionId,
		sourceEventId: row.sourceEventId,
		phase,
		toolName
	};
}

async function readExecutionAgentRuns(executionId: string): Promise<ExecutionReadModel['agentRuns']> {
	if (!db) return [];
	const rows = await db
		.select()
		.from(workflowAgentRuns)
		.where(eq(workflowAgentRuns.workflowExecutionId, executionId))
		.orderBy(asc(workflowAgentRuns.createdAt));

	return rows.map((row) => ({
		id: row.id,
		workflowExecutionId: row.workflowExecutionId,
		workflowId: row.workflowId,
		nodeId: row.nodeId,
		mode: row.mode,
		status: row.status,
		agentWorkflowId: row.agentWorkflowId,
		daprInstanceId: row.daprInstanceId,
		parentExecutionId: row.parentExecutionId,
		workspaceRef: row.workspaceRef ?? null,
		artifactRef: row.artifactRef ?? null,
		result: (row.result as Record<string, unknown> | null) ?? null,
		error: row.error ?? null,
		createdAt: toIso(row.createdAt),
		updatedAt: toIso(row.updatedAt),
		completedAt: toIso(row.completedAt)
	}));
}

async function readExecutionWorkspaces(
	executionId: string
): Promise<ExecutionReadModel['workspaces']> {
	if (!db) return [];
	const rows = await db
		.select()
		.from(workflowWorkspaceSessions)
		.where(eq(workflowWorkspaceSessions.workflowExecutionId, executionId))
		.orderBy(asc(workflowWorkspaceSessions.createdAt));

	return rows.map((row) => ({
		workspaceRef: row.workspaceRef,
		workflowExecutionId: row.workflowExecutionId,
		durableInstanceId: row.durableInstanceId ?? null,
		name: row.name,
		rootPath: row.rootPath,
		clonePath: row.clonePath ?? null,
		backend: row.backend,
		enabledTools: Array.isArray(row.enabledTools) ? row.enabledTools : [],
		requireReadBeforeWrite: row.requireReadBeforeWrite,
		commandTimeoutMs: row.commandTimeoutMs,
		status: row.status,
		lastError: row.lastError ?? null,
		createdAt: toIso(row.createdAt),
		updatedAt: toIso(row.updatedAt),
		lastAccessedAt: toIso(row.lastAccessedAt),
		cleanedAt: toIso(row.cleanedAt),
		sandboxState: (row.sandboxState as Record<string, unknown> | null) ?? null
	}));
}

export async function listExecutionAgentEvents(
	executionId: string,
	afterEventId: number
): Promise<ExecutionTimelineEvent[]> {
	if (!db) return [];

	// Phase 4 Step 2: query session_events via sessions.workflow_execution_id.
	// afterEventId is the session_events.sequence column (monotonic per session;
	// stable for pagination).
	const rows = await db
		.select({
			id: sessionEvents.id,
			sequence: sessionEvents.sequence,
			sessionId: sessionEvents.sessionId,
			type: sessionEvents.type,
			data: sessionEvents.data,
			sourceEventId: sessionEvents.sourceEventId,
			createdAt: sessionEvents.createdAt
		})
		.from(sessionEvents)
		.innerJoin(sessions, eq(sessions.id, sessionEvents.sessionId))
		.where(
			and(
				eq(sessions.workflowExecutionId, executionId),
				gt(sessionEvents.sequence, afterEventId)
			)
		)
		.orderBy(asc(sessionEvents.sequence));

	return rows.map((row) => mapSessionAgentEvent(row));
}

/**
 * List agent events for a specific sandbox name, across all sessions.
 * Used by the sandbox detail page + stream to show what happened in a
 * sandbox/runtime. Phase 4 Step 2b: reads from `session_events` joined on
 * `sessions.sandbox_name`, replacing the deleted `workflow_agent_events`
 * table. Pagination cursor is the session event's `sequence` column.
 */
export async function listSandboxAgentEvents(
	sandboxName: string,
	afterEventId: number = 0,
	limit: number = 200
): Promise<ExecutionTimelineEvent[]> {
	if (!db) return [];

	const rows = await db
		.select({
			id: sessionEvents.id,
			sequence: sessionEvents.sequence,
			sessionId: sessionEvents.sessionId,
			type: sessionEvents.type,
			data: sessionEvents.data,
			sourceEventId: sessionEvents.sourceEventId,
			createdAt: sessionEvents.createdAt
		})
		.from(sessionEvents)
		.innerJoin(sessions, eq(sessions.id, sessionEvents.sessionId))
		.where(
			and(
				eq(sessions.sandboxName, sandboxName),
				gt(sessionEvents.sequence, afterEventId)
			)
		)
		.orderBy(asc(sessionEvents.sequence))
		.limit(limit);

	return rows.map((row) => mapSessionAgentEvent(row));
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

type SerializeExecutionReadModelOptions = {
	compact?: boolean;
	includeAgentEvents?: boolean;
};

function compactStepLog(step: ExecutionStepLog): ExecutionStepLog {
	return {
		...step,
		input: null,
		output: null
	};
}

export function serializeExecutionReadModel(
	model: ExecutionReadModel,
	options?: SerializeExecutionReadModelOptions
): ExecutionReadModel {
	const includeAgentEvents = options?.includeAgentEvents ?? false;
	const compact = options?.compact ?? false;
	const shouldCompact = compact && !patchStatusIsTerminal(model.status);

	return {
		...model,
		output: shouldCompact ? model.summaryOutput ?? null : model.output,
		steps: shouldCompact ? model.steps.map((step) => compactStepLog(step)) : model.steps,
		agentRuns: model.agentRuns,
		agentEvents: includeAgentEvents ? model.agentEvents : []
	};
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

	const visibleRows = rows.filter((row) => !['trigger', 'state'].includes(row.nodeId));
	const attemptsByNode = new Map<string, number>();
	const totalsByNode = new Map<string, number>();

	for (const row of visibleRows) {
		totalsByNode.set(row.nodeId, (totalsByNode.get(row.nodeId) ?? 0) + 1);
	}

	return visibleRows.map((row) => {
		const attempt = (attemptsByNode.get(row.nodeId) ?? 0) + 1;
		attemptsByNode.set(row.nodeId, attempt);
		const attemptsTotal = totalsByNode.get(row.nodeId) ?? 1;
		const baseLabel = row.nodeName || row.nodeId;

		return {
			logId: row.id,
			stepName: row.nodeId,
			label: row.nodeName,
			displayLabel:
				attemptsTotal > 1 ? `${baseLabel} (attempt ${attempt})` : baseLabel,
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
			completedAt: toIso(row.completedAt),
			attempt,
			attemptsTotal
		};
	});
}

async function readTraceIds(execution: ExecutionRow) {
	const traceIds = new Set<string>();
	if (execution.primaryTraceId?.trim()) traceIds.add(execution.primaryTraceId.trim());
	for (const traceId of extractExecutionTraceIds(execution.output)) {
		traceIds.add(traceId);
	}

	// Phase 4 Step 2b: the legacy `workflow_agent_events.trace_id` sidecar is
	// gone. Session events carry traceId inside `data` when the agent runtime
	// stamps it — pull the last N and harvest any we find.
	if (db) {
		const rows = await db
			.select({ data: sessionEvents.data })
			.from(sessionEvents)
			.innerJoin(sessions, eq(sessions.id, sessionEvents.sessionId))
			.where(eq(sessions.workflowExecutionId, execution.id))
			.orderBy(desc(sessionEvents.sequence))
			.limit(200);

		for (const row of rows) {
			const data = isRecord(row.data) ? row.data : null;
			const traceId =
				data && typeof data.traceId === 'string' ? data.traceId.trim() : '';
			if (traceId) traceIds.add(traceId);
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

	const [steps, browserArtifacts, agentRuns, workspaces, agentEvents, traceIds] = await Promise.all([
		readExecutionSteps(executionId),
		listBrowserArtifactsByExecutionId(executionId),
		readExecutionAgentRuns(executionId),
		readExecutionWorkspaces(executionId),
		options?.includeAgentEvents === false ? Promise.resolve([]) : fetchRecentAgentEvents(executionId),
		readTraceIds(execution)
	]);

	// Step 2b: `last_agent_event_id` column dropped — the cursor comes from
	// the last session_events.sequence we returned (agentEvents[-1].id).
	const lastAgentEventId = agentEvents.at(-1)?.id ?? 0;
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
		agentRuns,
		workspaces,
		agentEvents,
		lastAgentEventId
	};
}

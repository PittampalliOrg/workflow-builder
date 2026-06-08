import { desc, eq, or } from 'drizzle-orm';
import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { sessions, workflowAgentRuns, workflowExecutions, workflows } from '$lib/server/db/schema';
import { daprFetch, getDaprAgentPyUrls, getOrchestratorUrl } from '$lib/server/dapr-client';
import {
	getCodeCheckpoint,
	listCodeCheckpointsForExecution
} from '$lib/server/workflows/code-checkpoints';
import { openshellRuntimeFetch } from '$lib/server/openshell-runtime';
import { buildCodeCheckpointReplayInput } from './replay-input';
import { stopDurableRun } from '$lib/server/lifecycle';

export type RuntimeStatus =
	| 'PENDING'
	| 'RUNNING'
	| 'COMPLETED'
	| 'FAILED'
	| 'TERMINATED'
	| 'SUSPENDED'
	| 'UNKNOWN'
	| string;

export interface DaprWorkflowInstance {
	instanceId: string;
	appId?: string | null;
	workflowId?: string | null;
	workflowName?: string | null;
	workflowVersion?: string | null;
	workflowNameVersioned?: string | null;
	runtimeStatus?: RuntimeStatus | null;
	traceId?: string | null;
	phase?: string | null;
	progress?: number | null;
	message?: string | null;
	currentNodeId?: string | null;
	currentNodeName?: string | null;
	approvalEventName?: string | null;
	outputs?: unknown;
	error?: string | null;
	stackTrace?: string | null;
	parentInstanceId?: string | null;
	startedAt?: string | null;
	completedAt?: string | null;
}

export interface DaprHistoryEvent {
	eventId?: number | null;
	eventType: string;
	timestamp?: string | null;
	name?: string | null;
	displayName?: string | null;
	runtimeName?: string | null;
	nodeId?: string | null;
	actionType?: string | null;
	input?: unknown;
	output?: unknown;
	metadata?: Record<string, unknown> | null;
	raw?: Record<string, unknown> | null;
}

export interface DbExecutionSummary {
	id: string;
	workflowId: string;
	workflowName: string | null;
	status: string;
	daprInstanceId: string | null;
	phase: string | null;
	progress: number | null;
	currentNodeId: string | null;
	currentNodeName: string | null;
	error: string | null;
	startedAt: string | null;
	completedAt: string | null;
	duration: string | null;
	rerunOfExecutionId: string | null;
	rerunSourceInstanceId: string | null;
	rerunFromEventId: number | null;
}

export interface AgentRunSummary {
	id: string;
	nodeId: string;
	mode: string;
	status: string;
	daprInstanceId: string;
	agentWorkflowId: string;
	error: string | null;
	createdAt: string | null;
	completedAt: string | null;
}

export interface AgentRunDetail {
	instanceId: string;
	agentRun: AgentRunSummary | null;
	status: DaprWorkflowInstance | null;
	history: DaprHistoryEvent[];
	codeCheckpoints: WorkflowOpsCodeCheckpoint[];
	graph: WorkflowGraph;
	replayEvents: ReplayableWorkflowEvent[];
	suggestedReplayEventId: number;
	serviceRuntime: string;
	serviceError: string | null;
}

export interface WorkflowDefinitionSummary {
	id: string;
	name: string;
	daprWorkflowName: string | null;
	description: string | null;
	updatedAt: string | null;
	nodes?: unknown[] | null;
	edges?: unknown[] | null;
}

export interface WorkflowOpsInstanceRow {
	instanceId: string;
	dapr: DaprWorkflowInstance | null;
	execution: DbExecutionSummary | null;
	workflow: WorkflowDefinitionSummary | null;
	runtimeStatus: RuntimeStatus;
	dbStatus: string | null;
	startedAt: string | null;
	completedAt: string | null;
	durationMs: number | null;
	isCorrelated: boolean;
}

export interface WorkflowOpsOverview {
	rows: WorkflowOpsInstanceRow[];
	workflows: WorkflowDefinitionSummary[];
	stats: {
		total: number;
		running: number;
		failed: number;
		completed: number;
		suspended: number;
		uncorrelated: number;
	};
	orchestratorError: string | null;
}

export interface StatusBreakdown {
	total: number;
	pending: number;
	running: number;
	suspended: number;
	completed: number;
	failed: number;
	terminated: number;
	unknown: number;
}

export interface WorkflowTypeSummary {
	appId: string;
	name: string;
	version: string | null;
	workflow: WorkflowDefinitionSummary | null;
	totalExecutions: number;
	statusCounts: StatusBreakdown;
	latestStartedAt: string | null;
	latestInstanceId: string | null;
}

export interface WorkflowGraphNode {
	id: string;
	kind: 'start' | 'activity' | 'timer' | 'external' | 'subworkflow' | 'workflow' | 'end' | 'other';
	name: string;
	runtimeName?: string | null;
	nodeId?: string | null;
	actionType?: string | null;
	eventId?: number | null;
	eventType?: string | null;
	status?: string | null;
	input?: unknown;
	output?: unknown;
}

export interface WorkflowGraphEdge {
	id: string;
	source: string;
	target: string;
}

export interface WorkflowGraph {
	appId: string;
	name: string;
	nodes: WorkflowGraphNode[];
	edges: WorkflowGraphEdge[];
	source: 'history' | 'definition' | 'empty';
}

export interface ReplayableWorkflowEvent {
	eventId: number;
	eventType: string;
	name: string;
	runtimeName?: string | null;
	nodeId?: string | null;
	actionType?: string | null;
	category: WorkflowGraphNode['kind'];
	input?: unknown;
	timestamp?: string | null;
	label: string;
}

export interface WorkflowRelationship {
	instanceId: string;
	status: RuntimeStatus;
	relationship: 'parent' | 'child' | 'rerun';
	appId: string;
	workflowName: string;
	startedAt: string | null;
	completedAt: string | null;
}

export interface WorkflowOpsCodeCheckpoint {
	id: string;
	workflowExecutionId?: string;
	workflowAgentRunId?: string | null;
	daprInstanceId?: string | null;
	workspaceRef?: string | null;
	sandboxName?: string | null;
	repoPath?: string | null;
	seq: number | null;
	toolName: string;
	status: string;
	beforeSha: string | null;
	afterSha: string | null;
	remoteUrl: string | null;
	remoteRef: string | null;
	remoteStatus: string | null;
	remoteError: string | null;
	fileCount: number;
	createdAt: string;
}

export interface WorkflowOpsDetail {
	instanceId: string;
	status: DaprWorkflowInstance | null;
	history: DaprHistoryEvent[];
	execution: DbExecutionSummary | null;
	workflow: WorkflowDefinitionSummary | null;
	agentRuns: AgentRunSummary[];
	codeCheckpoints: WorkflowOpsCodeCheckpoint[];
	graph: WorkflowGraph;
	replayEvents: ReplayableWorkflowEvent[];
	suggestedReplayEventId: number;
	relationships: WorkflowRelationship[];
	orchestratorError: string | null;
}

type ListInstancesParams = {
	status?: string | null;
	search?: string | null;
	limit?: number;
	offset?: number;
};

type OperationOptions = {
	reason?: string;
	fromEventId?: number;
	newInstanceId?: string;
	overwriteInput?: boolean;
	input?: unknown;
	codeCheckpointId?: string;
	restoreMode?: 'live' | 'fresh';
	eventName?: string;
	eventData?: unknown;
	force?: boolean;
	recursive?: boolean;
};

export const WORKFLOW_ORCHESTRATOR_ACTOR_TYPE =
	'dapr.internal.workflow-builder.workflow-orchestrator.workflow';

export type WorkflowActorReminderDeleteInput = {
	reminderNames: unknown;
	reason?: unknown;
	actorType?: unknown;
	actorId?: unknown;
};

export type WorkflowActorReminderDeleteRequest = {
	reminderNames: string[];
	reason?: string;
	actorType: typeof WORKFLOW_ORCHESTRATOR_ACTOR_TYPE;
	actorId: string;
};

function toIso(value: Date | string | null | undefined): string | null {
	if (!value) return null;
	if (value instanceof Date) return value.toISOString();
	return value;
}

function asErrorMessage(value: unknown): string {
	if (value instanceof Error) return value.message;
	if (typeof value === 'string') return value;
	const payload =
		value && typeof value === 'object'
			? ((value as { body?: unknown }).body ?? value)
			: null;
	if (payload && typeof payload === 'object') {
		const record = payload as Record<string, unknown>;
		if (typeof record.message === 'string') return record.message;
		if (typeof record.detail === 'string') return record.detail;
		if (typeof record.error === 'string') return record.error;
	}
	return 'Unknown error';
}

function parseMaybeJson(value: unknown): unknown {
	if (typeof value !== 'string' || !value.trim()) return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function sourceWorkflowInputFromHistory(history: DaprHistoryEvent[]): unknown {
	const started = history.find((event) =>
		event.eventType.toLowerCase().includes('executionstarted')
	);
	return parseMaybeJson(started?.input);
}

function replayEventInputFromHistory(
	history: DaprHistoryEvent[],
	eventId: number
): unknown {
	const event = history.find((candidate) => candidate.eventId === eventId);
	return parseMaybeJson(event?.input);
}

async function createFreshReplaySandbox(prefix: string): Promise<string> {
	const normalizedPrefix = prefix.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 36);
	const sandboxName = `${normalizedPrefix || 'workflow-replay'}-${Math.random().toString(36).slice(2, 8)}`;
	const response = await openshellRuntimeFetch('/api/v1/sandboxes', {
		method: 'POST',
		body: JSON.stringify({
			name: sandboxName,
			provider: 'claude'
		}),
		headers: { 'Content-Type': 'application/json' },
		signal: AbortSignal.timeout(15_000)
	});
	const body = await readJsonResponse(response);
	if (!response.ok) {
		throwUpstreamError(response.status, body, 'Failed to create a fresh replay sandbox');
	}
	return sandboxName;
}

async function readJsonResponse(response: Response): Promise<unknown> {
	const text = await response.text();
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function throwUpstreamError(status: number, body: unknown, fallback: string): never {
	const payload = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
	const message =
		typeof payload.error === 'string'
			? payload.error
			: typeof payload.message === 'string'
				? payload.message
				: typeof payload.detail === 'string'
					? payload.detail
					: fallback;
	throw error(status, { message });
}

export function validateWorkflowActorReminderDeleteInput(
	instanceId: string,
	input: WorkflowActorReminderDeleteInput
): WorkflowActorReminderDeleteRequest {
	const actorId = typeof input.actorId === 'string' && input.actorId.trim() ? input.actorId.trim() : instanceId;
	if (actorId !== instanceId) {
		throw error(400, { message: 'actorId must match the selected workflow instance id' });
	}
	const actorType =
		typeof input.actorType === 'string' && input.actorType.trim()
			? input.actorType.trim()
			: WORKFLOW_ORCHESTRATOR_ACTOR_TYPE;
	if (actorType !== WORKFLOW_ORCHESTRATOR_ACTOR_TYPE) {
		throw error(400, { message: `actorType must be ${WORKFLOW_ORCHESTRATOR_ACTOR_TYPE}` });
	}
	if (!Array.isArray(input.reminderNames)) {
		throw error(400, { message: 'reminderNames must be an array' });
	}
	const reminderNames = input.reminderNames
		.map((name) => (typeof name === 'string' ? name.trim() : ''))
		.filter(Boolean);
	if (reminderNames.length === 0) {
		throw error(400, { message: 'At least one reminder name is required' });
	}
	const invalid = reminderNames.find(
		(name) =>
			!name.startsWith('new-event-') ||
			name.includes('/') ||
			name.includes('\\') ||
			/[^\x20-\x7e]/.test(name)
	);
	if (invalid) {
		throw error(400, { message: 'Only explicit new-event-* reminder names may be deleted' });
	}
	const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : undefined;
	return {
		reminderNames,
		reason,
		actorType: WORKFLOW_ORCHESTRATOR_ACTOR_TYPE,
		actorId
	};
}

export async function deleteWorkflowActorReminders(
	instanceId: string,
	input: WorkflowActorReminderDeleteInput
): Promise<unknown> {
	const payload = validateWorkflowActorReminderDeleteInput(instanceId, input);
	const encoded = encodeURIComponent(instanceId);
	return orchestratorJson(`/api/internal/workflow-ops/instances/${encoded}/reminders/delete`, {
		method: 'POST',
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(20_000)
	});
}

async function orchestratorJson(path: string, init: RequestInit = {}): Promise<unknown> {
	const response = await daprFetch(`${getOrchestratorUrl()}${path}`, {
		...init,
		signal: init.signal ?? AbortSignal.timeout(5000),
		headers: {
			...(init.body ? { 'Content-Type': 'application/json' } : {}),
			...(init.headers ?? {})
		}
	});
	const body = await readJsonResponse(response);
	if (!response.ok) {
		throwUpstreamError(response.status, body, 'Workflow orchestrator request failed');
	}
	return body;
}

function candidateAgentRuntimes(agentRun?: AgentRunSummary | null): string[] {
	const text = `${agentRun?.daprInstanceId ?? ''} ${agentRun?.agentWorkflowId ?? ''}`;
	const preferred = text.includes('dapr-agent-py-testing') ? 'dapr-agent-py-testing' : 'dapr-agent-py';
	const fallback = preferred === 'dapr-agent-py' ? 'dapr-agent-py-testing' : 'dapr-agent-py';
	return [preferred, fallback];
}

async function agentJson(
	path: string,
	init: RequestInit = {},
	agentRun?: AgentRunSummary | null
): Promise<{ runtime: string; body: unknown }> {
	let lastError: unknown;
	for (const runtime of candidateAgentRuntimes(agentRun)) {
		for (const baseUrl of getDaprAgentPyUrls(runtime)) {
			let response: Response;
			try {
				response = await daprFetch(`${baseUrl}${path}`, {
					...init,
					signal: init.signal ?? AbortSignal.timeout(5000),
					headers: {
						...(init.body ? { 'Content-Type': 'application/json' } : {}),
						...(init.headers ?? {})
					}
				});
			} catch (err) {
				lastError = err;
				continue;
			}
			const body = await readJsonResponse(response);
			if (response.ok) return { runtime, body };
			lastError = { status: response.status, body };
			if (response.status !== 404) break;
		}
	}
	if (lastError instanceof Error) {
		throw error(502, { message: lastError.message });
	}
	const failure = lastError as { status?: number; body?: unknown } | undefined;
	throwUpstreamError(
		failure?.status ?? 502,
		failure?.body,
		'Durable agent request failed'
	);
}

function normalizeRuntimeStatus(value: string | null | undefined): RuntimeStatus {
	return (value || 'UNKNOWN').toUpperCase();
}

export function isActiveRuntimeStatus(status: string | null | undefined): boolean {
	return ['PENDING', 'RUNNING', 'CONTINUED_AS_NEW'].includes(normalizeRuntimeStatus(status));
}

export function isSuspendedRuntimeStatus(status: string | null | undefined): boolean {
	return normalizeRuntimeStatus(status) === 'SUSPENDED';
}

export function isTerminalRuntimeStatus(status: string | null | undefined): boolean {
	return ['COMPLETED', 'FAILED', 'TERMINATED', 'CANCELED', 'CANCELLED'].includes(
		normalizeRuntimeStatus(status)
	);
}

function durationMs(startedAt: string | null, completedAt: string | null): number | null {
	if (!startedAt) return null;
	const start = new Date(startedAt).getTime();
	if (!Number.isFinite(start)) return null;
	const end = completedAt ? new Date(completedAt).getTime() : Date.now();
	if (!Number.isFinite(end)) return null;
	return Math.max(0, end - start);
}

function executionCandidateFromInstanceId(instanceId: string): string | null {
	const execMatch = instanceId.match(/-exec-([A-Za-z0-9_-]+)/);
	if (execMatch?.[1]) return execMatch[1];
	const rerunMatch = instanceId.match(/-rerun-[^-]+-([A-Za-z0-9_-]+)$/);
	return rerunMatch?.[1] ?? null;
}

async function listDbExecutions(limit = 200): Promise<DbExecutionSummary[]> {
	if (!db) return [];
	const rows = await db
		.select({
			id: workflowExecutions.id,
			workflowId: workflowExecutions.workflowId,
			workflowName: workflows.name,
			status: workflowExecutions.status,
			daprInstanceId: workflowExecutions.daprInstanceId,
			phase: workflowExecutions.phase,
			progress: workflowExecutions.progress,
			currentNodeId: workflowExecutions.currentNodeId,
			currentNodeName: workflowExecutions.currentNodeName,
			error: workflowExecutions.error,
			startedAt: workflowExecutions.startedAt,
			completedAt: workflowExecutions.completedAt,
			duration: workflowExecutions.duration,
			rerunOfExecutionId: workflowExecutions.rerunOfExecutionId,
			rerunSourceInstanceId: workflowExecutions.rerunSourceInstanceId,
			rerunFromEventId: workflowExecutions.rerunFromEventId
		})
		.from(workflowExecutions)
		.leftJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
		.orderBy(desc(workflowExecutions.startedAt))
		.limit(limit);

	return rows.map((row) => ({
		...row,
		startedAt: toIso(row.startedAt),
		completedAt: toIso(row.completedAt)
	}));
}

async function listWorkflowDefinitions(limit = 100): Promise<WorkflowDefinitionSummary[]> {
	if (!db) return [];
	const rows = await db
		.select({
			id: workflows.id,
			name: workflows.name,
			daprWorkflowName: workflows.daprWorkflowName,
			description: workflows.description,
			updatedAt: workflows.updatedAt,
			nodes: workflows.nodes,
			edges: workflows.edges
		})
		.from(workflows)
		.orderBy(desc(workflows.updatedAt))
		.limit(limit);

	return rows.map((row) => ({
		...row,
		updatedAt: toIso(row.updatedAt)
	}));
}

async function findDbExecutionForInstance(instanceId: string): Promise<DbExecutionSummary | null> {
	if (!db) return null;
	const candidate = executionCandidateFromInstanceId(instanceId);
	const whereClause = candidate
		? or(eq(workflowExecutions.daprInstanceId, instanceId), eq(workflowExecutions.id, candidate))
		: eq(workflowExecutions.daprInstanceId, instanceId);
	const [row] = await db
		.select({
			id: workflowExecutions.id,
			workflowId: workflowExecutions.workflowId,
			workflowName: workflows.name,
			status: workflowExecutions.status,
			daprInstanceId: workflowExecutions.daprInstanceId,
			phase: workflowExecutions.phase,
			progress: workflowExecutions.progress,
			currentNodeId: workflowExecutions.currentNodeId,
			currentNodeName: workflowExecutions.currentNodeName,
			error: workflowExecutions.error,
			startedAt: workflowExecutions.startedAt,
			completedAt: workflowExecutions.completedAt,
			duration: workflowExecutions.duration,
			rerunOfExecutionId: workflowExecutions.rerunOfExecutionId,
			rerunSourceInstanceId: workflowExecutions.rerunSourceInstanceId,
			rerunFromEventId: workflowExecutions.rerunFromEventId
		})
		.from(workflowExecutions)
		.leftJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
		.where(whereClause)
		.limit(1);

	if (!row) return null;
	return {
		...row,
		startedAt: toIso(row.startedAt),
		completedAt: toIso(row.completedAt)
	};
}

async function getWorkflowDefinition(workflowId: string | null | undefined): Promise<WorkflowDefinitionSummary | null> {
	if (!db || !workflowId) return null;
	const [row] = await db
		.select({
			id: workflows.id,
			name: workflows.name,
			daprWorkflowName: workflows.daprWorkflowName,
			description: workflows.description,
			updatedAt: workflows.updatedAt,
			nodes: workflows.nodes,
			edges: workflows.edges
		})
		.from(workflows)
		.where(eq(workflows.id, workflowId))
		.limit(1);
	if (!row) return null;
	return {
		...row,
		updatedAt: toIso(row.updatedAt)
	};
}

async function listAgentRuns(executionId: string | null | undefined): Promise<AgentRunSummary[]> {
	if (!db || !executionId) return [];
	const rows = await db
		.select({
			id: workflowAgentRuns.id,
			nodeId: workflowAgentRuns.nodeId,
			mode: workflowAgentRuns.mode,
			status: workflowAgentRuns.status,
			daprInstanceId: workflowAgentRuns.daprInstanceId,
			agentWorkflowId: workflowAgentRuns.agentWorkflowId,
			error: workflowAgentRuns.error,
			createdAt: workflowAgentRuns.createdAt,
			completedAt: workflowAgentRuns.completedAt
		})
		.from(workflowAgentRuns)
		.where(eq(workflowAgentRuns.workflowExecutionId, executionId))
		.orderBy(desc(workflowAgentRuns.createdAt))
		.limit(50);

	return rows.map((row) => ({
		...row,
		createdAt: toIso(row.createdAt),
		completedAt: toIso(row.completedAt)
	}));
}

async function findAgentRun(agentRunIdOrInstanceId: string): Promise<AgentRunSummary | null> {
	if (!db) return null;
	const [row] = await db
		.select({
			id: workflowAgentRuns.id,
			nodeId: workflowAgentRuns.nodeId,
			mode: workflowAgentRuns.mode,
			status: workflowAgentRuns.status,
			daprInstanceId: workflowAgentRuns.daprInstanceId,
			agentWorkflowId: workflowAgentRuns.agentWorkflowId,
			error: workflowAgentRuns.error,
			createdAt: workflowAgentRuns.createdAt,
			completedAt: workflowAgentRuns.completedAt
		})
		.from(workflowAgentRuns)
		.where(
			or(
				eq(workflowAgentRuns.id, agentRunIdOrInstanceId),
				eq(workflowAgentRuns.daprInstanceId, agentRunIdOrInstanceId),
				eq(workflowAgentRuns.agentWorkflowId, agentRunIdOrInstanceId)
			)
		)
		.limit(1);

	if (!row) return null;
	return {
		...row,
		createdAt: toIso(row.createdAt),
		completedAt: toIso(row.completedAt)
	};
}

async function listDaprInstances(params: ListInstancesParams = {}): Promise<DaprWorkflowInstance[]> {
	const query = new URLSearchParams();
	if (params.status) query.set('status', params.status);
	if (params.search) query.set('search', params.search);
	query.set('limit', String(params.limit ?? 100));
	query.set('offset', String(params.offset ?? 0));

	const body = await orchestratorJson(`/api/v2/workflows?${query.toString()}`);
	const workflowsPayload =
		body && typeof body === 'object' && Array.isArray((body as { workflows?: unknown }).workflows)
			? ((body as { workflows: DaprWorkflowInstance[] }).workflows)
			: [];
	return workflowsPayload;
}

function buildRows(
	daprInstances: DaprWorkflowInstance[],
	executions: DbExecutionSummary[],
	definitions: WorkflowDefinitionSummary[]
): WorkflowOpsInstanceRow[] {
	const executionsByInstance = new Map<string, DbExecutionSummary>();
	const executionsById = new Map<string, DbExecutionSummary>();
	for (const execution of executions) {
		executionsById.set(execution.id, execution);
		if (execution.daprInstanceId) executionsByInstance.set(execution.daprInstanceId, execution);
	}

	const definitionsById = new Map(definitions.map((workflow) => [workflow.id, workflow]));
	const seenExecutionIds = new Set<string>();
	const rows: WorkflowOpsInstanceRow[] = [];

	for (const dapr of daprInstances) {
		const candidate = executionCandidateFromInstanceId(dapr.instanceId);
		const execution =
			executionsByInstance.get(dapr.instanceId) || (candidate ? executionsById.get(candidate) : undefined) || null;
		if (execution) seenExecutionIds.add(execution.id);
		const workflow =
			(execution ? definitionsById.get(execution.workflowId) : undefined) ||
			(dapr.workflowId ? definitionsById.get(dapr.workflowId) : undefined) ||
			null;
		const startedAt = dapr.startedAt ?? execution?.startedAt ?? null;
		const completedAt = dapr.completedAt ?? execution?.completedAt ?? null;
		rows.push({
			instanceId: dapr.instanceId,
			dapr,
			execution,
			workflow,
			runtimeStatus: normalizeRuntimeStatus(dapr.runtimeStatus),
			dbStatus: execution?.status ?? null,
			startedAt,
			completedAt,
			durationMs: durationMs(startedAt, completedAt),
			isCorrelated: Boolean(execution)
		});
	}

	for (const execution of executions) {
		if (seenExecutionIds.has(execution.id)) continue;
		const instanceId = execution.daprInstanceId ?? execution.id;
		const workflow = definitionsById.get(execution.workflowId) ?? null;
		rows.push({
			instanceId,
			dapr: null,
			execution,
			workflow,
			runtimeStatus: 'UNKNOWN',
			dbStatus: execution.status,
			startedAt: execution.startedAt,
			completedAt: execution.completedAt,
			durationMs: durationMs(execution.startedAt, execution.completedAt),
			isCorrelated: false
		});
	}

	return rows.sort((left, right) => {
		const leftTime = left.startedAt ? new Date(left.startedAt).getTime() : 0;
		const rightTime = right.startedAt ? new Date(right.startedAt).getTime() : 0;
		return rightTime - leftTime;
	});
}

function buildStats(rows: WorkflowOpsInstanceRow[]): WorkflowOpsOverview['stats'] {
	return {
		total: rows.length,
		running: rows.filter((row) => isActiveRuntimeStatus(row.runtimeStatus) || row.dbStatus === 'running').length,
		failed: rows.filter((row) => row.runtimeStatus === 'FAILED' || row.dbStatus === 'error').length,
		completed: rows.filter((row) => row.runtimeStatus === 'COMPLETED' || row.dbStatus === 'success').length,
		suspended: rows.filter((row) => isSuspendedRuntimeStatus(row.runtimeStatus)).length,
		uncorrelated: rows.filter((row) => !row.isCorrelated && row.dapr).length
	};
}

function appIdForRow(row: WorkflowOpsInstanceRow): string {
	return row.dapr?.appId || 'workflow-orchestrator';
}

function workflowNameForRow(row: WorkflowOpsInstanceRow): string {
	return (
		row.workflow?.daprWorkflowName ||
		row.workflow?.name ||
		row.dapr?.workflowName ||
		row.execution?.workflowName ||
		row.dapr?.workflowId ||
		row.execution?.workflowId ||
		'unknown-workflow'
	);
}

function emptyStatusBreakdown(): StatusBreakdown {
	return {
		total: 0,
		pending: 0,
		running: 0,
		suspended: 0,
		completed: 0,
		failed: 0,
		terminated: 0,
		unknown: 0
	};
}

function addStatus(counts: StatusBreakdown, status: string | null | undefined): void {
	const normalized = normalizeRuntimeStatus(status);
	counts.total += 1;
	if (['PENDING'].includes(normalized)) counts.pending += 1;
	else if (['RUNNING', 'CONTINUED_AS_NEW'].includes(normalized)) counts.running += 1;
	else if (normalized === 'SUSPENDED') counts.suspended += 1;
	else if (normalized === 'COMPLETED' || status === 'success') counts.completed += 1;
	else if (normalized === 'FAILED' || status === 'error') counts.failed += 1;
	else if (['TERMINATED', 'CANCELED', 'CANCELLED'].includes(normalized) || status === 'cancelled') {
		counts.terminated += 1;
	} else {
		counts.unknown += 1;
	}
}

function effectiveStatusForRow(row: WorkflowOpsInstanceRow): string {
	if (row.runtimeStatus && row.runtimeStatus !== 'UNKNOWN') return row.runtimeStatus;
	if (row.dbStatus === 'success') return 'COMPLETED';
	if (row.dbStatus === 'running') return 'RUNNING';
	if (row.dbStatus === 'pending') return 'PENDING';
	if (row.dbStatus === 'error') return 'FAILED';
	if (row.dbStatus === 'cancelled') return 'TERMINATED';
	return 'UNKNOWN';
}

function matchesWorkflow(row: WorkflowOpsInstanceRow, appId: string, name: string): boolean {
	return appIdForRow(row) === appId && workflowNameForRow(row) === name;
}

function applyExecutionFilters(
	rows: WorkflowOpsInstanceRow[],
	params: ListInstancesParams & {
		rootOnly?: boolean;
		latestOnly?: boolean;
		appId?: string | null;
		name?: string | null;
	}
): WorkflowOpsInstanceRow[] {
	let filtered = rows;
	if (params.appId && params.name) {
		filtered = filtered.filter((row) => matchesWorkflow(row, params.appId!, params.name!));
	}
	if (params.rootOnly) {
		filtered = filtered.filter((row) => !row.dapr?.parentInstanceId);
	}
	if (params.latestOnly) {
		const rerunSources = new Set<string>();
		for (const row of filtered) {
			if (row.execution?.rerunSourceInstanceId) rerunSources.add(row.execution.rerunSourceInstanceId);
		}
		filtered = filtered.filter((row) => !rerunSources.has(row.instanceId));
	}
	return filtered;
}

function buildWorkflowTypes(rows: WorkflowOpsInstanceRow[]): WorkflowTypeSummary[] {
	const groups = new Map<string, WorkflowTypeSummary>();
	for (const row of rows) {
		const appId = appIdForRow(row);
		const name = workflowNameForRow(row);
		const key = `${appId}\u0000${name}`;
		let group = groups.get(key);
		if (!group) {
			group = {
				appId,
				name,
				version: row.dapr?.workflowVersion ?? null,
				workflow: row.workflow,
				totalExecutions: 0,
				statusCounts: emptyStatusBreakdown(),
				latestStartedAt: null,
				latestInstanceId: null
			};
			groups.set(key, group);
		}
		group.totalExecutions += 1;
		addStatus(group.statusCounts, effectiveStatusForRow(row));
		const startedAt = row.startedAt;
		if (
			startedAt &&
			(!group.latestStartedAt || new Date(startedAt).getTime() > new Date(group.latestStartedAt).getTime())
		) {
			group.latestStartedAt = startedAt;
			group.latestInstanceId = row.instanceId;
		}
		if (!group.workflow && row.workflow) group.workflow = row.workflow;
	}
	return [...groups.values()].sort((left, right) => {
		const leftTime = left.latestStartedAt ? new Date(left.latestStartedAt).getTime() : 0;
		const rightTime = right.latestStartedAt ? new Date(right.latestStartedAt).getTime() : 0;
		return rightTime - leftTime;
	});
}

function eventKind(event: DaprHistoryEvent): WorkflowGraphNode['kind'] {
	const type = event.eventType.toLowerCase();
	const name = (event.name ?? '').toLowerCase();
	if (type.includes('executionstarted')) return 'start';
	if (type.includes('executioncompleted') || type.includes('executionterminated')) return 'end';
	if (type.includes('suborchestration') || name.includes('subworkflow')) return 'subworkflow';
	if (type.includes('timer')) return 'timer';
	if (type.includes('event')) return 'external';
	if (type.includes('task') || type.includes('activity')) return 'activity';
	return 'other';
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function eventInputRecord(event: DaprHistoryEvent): Record<string, unknown> | null {
	return asRecord(event.input);
}

function nodeRecordForEvent(event: DaprHistoryEvent): Record<string, unknown> | null {
	return asRecord(eventInputRecord(event)?.node);
}

function nodeDataRecordForEvent(event: DaprHistoryEvent): Record<string, unknown> | null {
	return asRecord(nodeRecordForEvent(event)?.data);
}

function nodeConfigRecordForEvent(event: DaprHistoryEvent): Record<string, unknown> | null {
	const node = nodeRecordForEvent(event);
	return asRecord(node?.config) ?? asRecord(nodeDataRecordForEvent(event)?.config);
}

function eventNodeId(event: DaprHistoryEvent): string | null {
	const node = nodeRecordForEvent(event);
	return stringValue(node?.id) ?? stringValue(nodeDataRecordForEvent(event)?.id);
}

function eventActionType(event: DaprHistoryEvent): string | null {
	const config = nodeConfigRecordForEvent(event);
	return stringValue(config?.actionType) ?? stringValue(config?.call) ?? stringValue(config?.type);
}

function eventDisplayName(event: DaprHistoryEvent): string {
	const node = nodeRecordForEvent(event);
	const data = nodeDataRecordForEvent(event);
	const config = nodeConfigRecordForEvent(event);
	return (
		stringValue(node?.label) ??
		stringValue(data?.label) ??
		stringValue(config?.label) ??
		stringValue(node?.id) ??
		eventActionType(event) ??
		stringValue(event.name) ??
		event.eventType
	);
}

function enrichHistoryEvent(event: DaprHistoryEvent): DaprHistoryEvent {
	return {
		...event,
		displayName: event.displayName ?? eventDisplayName(event),
		runtimeName: event.runtimeName ?? event.name ?? null,
		nodeId: event.nodeId ?? eventNodeId(event),
		actionType: event.actionType ?? eventActionType(event)
	};
}

function isReplayableEvent(event: DaprHistoryEvent): event is DaprHistoryEvent & { eventId: number } {
	if (typeof event.eventId !== 'number') return false;
	const type = event.eventType.toLowerCase();
	return (
		type.includes('scheduled') ||
		type.includes('timercreated') ||
		type.includes('eventraised') ||
		type.includes('suborchestrationinstancecreated')
	);
}

function chronologicalHistory(history: DaprHistoryEvent[]): DaprHistoryEvent[] {
	return history
		.map((event, index) => ({ event, index }))
		.sort((left, right) => {
			const leftTime = left.event.timestamp ? new Date(left.event.timestamp).getTime() : 0;
			const rightTime = right.event.timestamp ? new Date(right.event.timestamp).getTime() : 0;
			if (leftTime !== rightTime) return leftTime - rightTime;
			return (left.event.eventId ?? -1) - (right.event.eventId ?? -1) || left.index - right.index;
		})
		.map(({ event }) => event);
}

function buildReplayEvents(history: DaprHistoryEvent[]): ReplayableWorkflowEvent[] {
	return chronologicalHistory(history).filter(isReplayableEvent).map((event) => {
		const category = eventKind(event);
		const name = event.displayName || eventDisplayName(event);
		const runtimeName = event.runtimeName ?? event.name ?? null;
		const actionType = event.actionType ?? eventActionType(event);
		const nodeId = event.nodeId ?? eventNodeId(event);
		const metadata = [actionType, runtimeName && runtimeName !== name ? `Dapr: ${runtimeName}` : null]
			.filter(Boolean)
			.join(' · ');
		return {
			eventId: event.eventId,
			eventType: event.eventType,
			name,
			runtimeName,
			nodeId,
			actionType,
			category,
			input: event.input,
			timestamp: event.timestamp,
			label: `${event.eventId} - ${name}${metadata ? ` · ${metadata}` : ''} (${category})`
		};
	});
}

function suggestedReplayEventId(history: DaprHistoryEvent[], replayEvents: ReplayableWorkflowEvent[]): number {
	const failed = [...history].reverse().find((event) => event.eventType.toLowerCase().includes('failed'));
	if (failed) {
		const failedNodeId = failed.nodeId ?? eventNodeId(failed);
		const failedName = failed.displayName ?? eventDisplayName(failed);
		const matching = [...replayEvents]
			.reverse()
			.find((event) => (failedNodeId && event.nodeId === failedNodeId) || event.name === failedName);
		if (matching) return matching.eventId;
	}
	return replayEvents.at(-1)?.eventId ?? 0;
}

function buildHistoryGraph(appId: string, name: string, history: DaprHistoryEvent[]): WorkflowGraph {
	if (!history.length) return { appId, name, nodes: [], edges: [], source: 'empty' };
	const visible = history.filter((event) => {
		const type = event.eventType.toLowerCase();
		return (
			type.includes('executionstarted') ||
			type.includes('executioncompleted') ||
			type.includes('executionfailed') ||
			type.includes('executionterminated') ||
			isReplayableEvent(event)
		);
	});
	const events = chronologicalHistory(visible.length ? visible : history);
	const nodes = events.map((event, index) => ({
		id: typeof event.eventId === 'number' ? `event-${event.eventId}-${index}` : `event-${index}`,
		kind: eventKind(event),
		name: event.displayName || eventDisplayName(event),
		runtimeName: event.runtimeName ?? event.name ?? null,
		nodeId: event.nodeId ?? eventNodeId(event),
		actionType: event.actionType ?? eventActionType(event),
		eventId: event.eventId,
		eventType: event.eventType,
		status: event.eventType.toLowerCase().includes('failed')
			? 'failed'
			: event.eventType.toLowerCase().includes('completed')
				? 'success'
				: null,
		input: event.input,
		output: event.output
	}));
	const edges = nodes.slice(1).map((node, index) => ({
		id: `${nodes[index].id}-${node.id}-${index}`,
		source: nodes[index].id,
		target: node.id
	}));
	return { appId, name, nodes, edges, source: 'history' };
}

function buildDefinitionGraph(appId: string, workflow: WorkflowDefinitionSummary | null): WorkflowGraph {
	const name = workflow?.daprWorkflowName || workflow?.name || 'unknown-workflow';
	const rawNodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
	if (!rawNodes.length) return { appId, name, nodes: [], edges: [], source: 'empty' };
	const nodes = rawNodes.map((node, index) => {
		const record = node && typeof node === 'object' ? (node as Record<string, unknown>) : {};
		const data = record.data && typeof record.data === 'object' ? (record.data as Record<string, unknown>) : {};
		const kind = String(data.type || record.type || 'other').toLowerCase();
		return {
			id: String(record.id || `node-${index}`),
			kind: kind.includes('start')
				? 'start'
				: kind.includes('end')
					? 'end'
					: kind.includes('wait') || kind.includes('listen')
						? 'external'
						: kind.includes('run')
							? 'subworkflow'
							: 'activity',
			name: String(data.label || data.name || record.id || `Step ${index + 1}`)
		} satisfies WorkflowGraphNode;
	});
	const rawEdges = Array.isArray(workflow?.edges) ? workflow.edges : [];
	const edges = rawEdges
		.map((edge, index) => {
			const record = edge && typeof edge === 'object' ? (edge as Record<string, unknown>) : {};
			const source = typeof record.source === 'string' ? record.source : null;
			const target = typeof record.target === 'string' ? record.target : null;
			if (!source || !target) return null;
			return { id: String(record.id || `edge-${index}`), source, target };
		})
		.filter((edge): edge is WorkflowGraphEdge => Boolean(edge));
	return { appId, name, nodes, edges, source: 'definition' };
}

function buildRelationships(instanceId: string, rows: WorkflowOpsInstanceRow[]): WorkflowRelationship[] {
	const current = rows.find((row) => row.instanceId === instanceId);
	const relationships: WorkflowRelationship[] = [];
	if (current?.dapr?.parentInstanceId) {
		const parent = rows.find((row) => row.instanceId === current.dapr?.parentInstanceId);
		relationships.push({
			instanceId: current.dapr.parentInstanceId,
			status: parent ? effectiveStatusForRow(parent) : 'UNKNOWN',
			relationship: 'parent',
			appId: parent ? appIdForRow(parent) : appIdForRow(current),
			workflowName: parent ? workflowNameForRow(parent) : 'Parent workflow',
			startedAt: parent?.startedAt ?? null,
			completedAt: parent?.completedAt ?? null
		});
	}
	for (const row of rows) {
		if (row.dapr?.parentInstanceId === instanceId) {
			relationships.push({
				instanceId: row.instanceId,
				status: effectiveStatusForRow(row),
				relationship: 'child',
				appId: appIdForRow(row),
				workflowName: workflowNameForRow(row),
				startedAt: row.startedAt,
				completedAt: row.completedAt
			});
		}
		if (row.execution?.rerunSourceInstanceId === instanceId) {
			relationships.push({
				instanceId: row.instanceId,
				status: effectiveStatusForRow(row),
				relationship: 'rerun',
				appId: appIdForRow(row),
				workflowName: workflowNameForRow(row),
				startedAt: row.startedAt,
				completedAt: row.completedAt
			});
		}
	}
	return relationships;
}

export async function getWorkflowOpsOverview(params: ListInstancesParams = {}): Promise<WorkflowOpsOverview> {
	const [executions, definitions, daprResult] = await Promise.all([
		listDbExecutions(250),
		listWorkflowDefinitions(200),
		listDaprInstances(params).then(
			(workflows) => ({ workflows, error: null }),
			(err) => ({ workflows: [] as DaprWorkflowInstance[], error: asErrorMessage(err) })
		)
	]);
	const rows = buildRows(daprResult.workflows, executions, definitions);
	return {
		rows,
		workflows: definitions,
		stats: buildStats(rows),
		orchestratorError: daprResult.error
	};
}

export async function getWorkflowOpsWorkflowTypes(
	params: ListInstancesParams = {}
): Promise<WorkflowOpsOverview & { workflowTypes: WorkflowTypeSummary[] }> {
	const overview = await getWorkflowOpsOverview(params);
	return {
		...overview,
		workflowTypes: buildWorkflowTypes(overview.rows)
	};
}

export async function getWorkflowOpsExecutions(
	params: ListInstancesParams & {
		rootOnly?: boolean;
		latestOnly?: boolean;
		appId?: string | null;
		name?: string | null;
	} = {}
): Promise<WorkflowOpsOverview> {
	const overview = await getWorkflowOpsOverview(params);
	const rows = applyExecutionFilters(overview.rows, params);
	return {
		...overview,
		rows,
		stats: buildStats(rows)
	};
}

export async function getWorkflowOpsWorkflowType(
	appId: string,
	name: string,
	params: ListInstancesParams & { latestOnly?: boolean } = {}
): Promise<{
	summary: WorkflowTypeSummary;
	executions: WorkflowOpsInstanceRow[];
	graph: WorkflowGraph;
	orchestratorError: string | null;
}> {
	const overview = await getWorkflowOpsExecutions({
		...params,
		appId,
		name,
		latestOnly: params.latestOnly
	});
	const summary =
		buildWorkflowTypes(overview.rows).find((workflowType) => workflowType.appId === appId && workflowType.name === name) ??
		({
			appId,
			name,
			version: null,
			workflow: overview.workflows.find((workflow) => workflow.daprWorkflowName === name || workflow.name === name) ?? null,
			totalExecutions: 0,
			statusCounts: emptyStatusBreakdown(),
			latestStartedAt: null,
			latestInstanceId: null
		} satisfies WorkflowTypeSummary);
	const graph = buildDefinitionGraph(appId, summary.workflow);
	return {
		summary,
		executions: overview.rows,
		graph,
		orchestratorError: overview.orchestratorError
	};
}

export async function getWorkflowOpsDetail(instanceId: string): Promise<WorkflowOpsDetail> {
	const execution = await findDbExecutionForInstance(instanceId);
	const workflow = await getWorkflowDefinition(execution?.workflowId ?? null);
	const [statusResult, historyResult, agentRuns, overviewResult] = await Promise.all([
		orchestratorJson(`/api/v2/workflows/${encodeURIComponent(instanceId)}/status`).then(
			(status) => ({ status: status as DaprWorkflowInstance, error: null }),
			(err) => ({ status: null, error: asErrorMessage(err) })
		),
		orchestratorJson(`/api/v2/workflows/${encodeURIComponent(instanceId)}/history`).then(
			(history) => ({
				events:
					history && typeof history === 'object' && Array.isArray((history as { events?: unknown }).events)
						? ((history as { events: DaprHistoryEvent[] }).events)
						: [],
				error: null
			}),
			(err) => ({ events: [] as DaprHistoryEvent[], error: asErrorMessage(err) })
		),
		listAgentRuns(execution?.id),
		getWorkflowOpsOverview({ limit: 250 }).then(
			(overview) => ({ rows: overview.rows, error: null }),
			(err) => ({ rows: [] as WorkflowOpsInstanceRow[], error: asErrorMessage(err) })
		)
	]);
	const effectiveWorkflow =
		workflow ??
		(execution
			? {
					id: execution.workflowId,
					name: execution.workflowName ?? execution.workflowId,
					daprWorkflowName: null,
					description: null,
					updatedAt: null
				}
			: null);
	const appId = statusResult.status?.appId || 'workflow-orchestrator';
	const name =
		effectiveWorkflow?.daprWorkflowName ||
		effectiveWorkflow?.name ||
		statusResult.status?.workflowName ||
		statusResult.status?.workflowId ||
		'unknown-workflow';
	const history = historyResult.events.map(enrichHistoryEvent);
	const replayEvents = buildReplayEvents(history);
	const codeCheckpoints = execution?.id
		? await listCodeCheckpointsForExecution(execution.id)
		: [];

	return {
		instanceId,
		status: statusResult.status,
		history,
		execution,
		workflow: effectiveWorkflow,
		agentRuns,
		codeCheckpoints,
		graph: history.length
			? buildHistoryGraph(appId, name, history)
			: buildDefinitionGraph(appId, effectiveWorkflow),
		replayEvents,
		suggestedReplayEventId: suggestedReplayEventId(history, replayEvents),
		relationships: buildRelationships(instanceId, overviewResult.rows),
		orchestratorError: statusResult.error ?? historyResult.error ?? overviewResult.error
	};
}

function childRunInstanceId(agentRunIdOrInstanceId: string, agentRun: AgentRunSummary | null): string {
	return agentRun?.daprInstanceId || agentRun?.agentWorkflowId || agentRunIdOrInstanceId;
}

function checkpointsForAgentRun(
	checkpoints: WorkflowOpsCodeCheckpoint[],
	agentRun: AgentRunSummary | null,
	instanceId: string
): WorkflowOpsCodeCheckpoint[] {
	if (!agentRun) {
		return checkpoints.filter((checkpoint) => checkpoint.daprInstanceId === instanceId);
	}
	return checkpoints.filter(
		(checkpoint) =>
			checkpoint.workflowAgentRunId === agentRun.id ||
			checkpoint.daprInstanceId === agentRun.daprInstanceId ||
			checkpoint.daprInstanceId === agentRun.agentWorkflowId
	);
}

export async function getWorkflowOpsAgentRun(agentRunIdOrInstanceId: string): Promise<AgentRunDetail> {
	const agentRun = await findAgentRun(agentRunIdOrInstanceId);
	const instanceId = childRunInstanceId(agentRunIdOrInstanceId, agentRun);
	const [statusResult, historyResult] = await Promise.all([
		agentJson(`/api/v2/agent-runs/${encodeURIComponent(instanceId)}/status`, {}, agentRun).then(
			(result) => ({ status: result.body as DaprWorkflowInstance, runtime: result.runtime, error: null }),
			(err) => ({ status: null, runtime: 'dapr-agent-py', error: asErrorMessage(err) })
		),
		agentJson(`/api/v2/agent-runs/${encodeURIComponent(instanceId)}/history`, {}, agentRun).then(
			(result) => ({
				events:
					result.body && typeof result.body === 'object' && Array.isArray((result.body as { events?: unknown }).events)
						? ((result.body as { events: DaprHistoryEvent[] }).events)
						: [],
				runtime: result.runtime,
				error: null
			}),
			(err) => ({ events: [] as DaprHistoryEvent[], runtime: 'dapr-agent-py', error: asErrorMessage(err) })
		)
	]);
	const history = historyResult.events.map(enrichHistoryEvent);
	const replayEvents = buildReplayEvents(history);
	const allCheckpoints = agentRun
		? await listCodeCheckpointsForExecution(
				(
					await db
						?.select({ workflowExecutionId: workflowAgentRuns.workflowExecutionId })
						.from(workflowAgentRuns)
						.where(eq(workflowAgentRuns.id, agentRun.id))
						.limit(1)
				)?.[0]?.workflowExecutionId ?? ''
			)
		: [];
	const codeCheckpoints = checkpointsForAgentRun(allCheckpoints, agentRun, instanceId);
	const runtime = statusResult.runtime || historyResult.runtime || 'dapr-agent-py';
	const appId = statusResult.status?.appId || runtime;
	const name = statusResult.status?.workflowName || statusResult.status?.workflowId || runtime;

	return {
		instanceId,
		agentRun,
		status: statusResult.status,
		history,
		codeCheckpoints,
		graph: buildHistoryGraph(appId, name, history),
		replayEvents,
		suggestedReplayEventId: suggestedReplayEventId(history, replayEvents),
		serviceRuntime: runtime,
		serviceError: statusResult.error ?? historyResult.error
	};
}

/**
 * Resolve a raw Dapr workflow/agent instance id to the Lifecycle-Controller target
 * (the DB row that owns it), so admin terminate/purge can route through the vetted
 * stopDurableRun cascade (per-session app-id fan-out + fail-closed + Sandbox-CR
 * reap + DB flip) instead of a raw orchestrator/agent call. Returns null for
 * instances with no DB correlation, where the raw op remains the fallback.
 */
async function lifecycleTargetForInstance(
	instanceId: string
): Promise<{ kind: 'workflowExecution' | 'session'; id: string } | null> {
	const database = db;
	if (!database || !instanceId) return null;
	const [exec] = await database
		.select({ id: workflowExecutions.id })
		.from(workflowExecutions)
		.where(
			or(
				eq(workflowExecutions.id, instanceId),
				eq(workflowExecutions.daprInstanceId, instanceId)
			)
		)
		.limit(1);
	if (exec?.id) return { kind: 'workflowExecution', id: exec.id };
	const [sess] = await database
		.select({ id: sessions.id })
		.from(sessions)
		.where(or(eq(sessions.id, instanceId), eq(sessions.daprInstanceId, instanceId)))
		.limit(1);
	if (sess?.id) return { kind: 'session', id: sess.id };
	return null;
}

/**
 * Drive a terminate/purge through the vetted Lifecycle Controller and surface
 * its fail-closed contract (409 when the durable tree did not confirm closure).
 */
async function stopThroughController(
	target: { kind: 'workflowExecution' | 'session'; id: string },
	mode: 'terminate' | 'purge',
	reason: string | undefined,
	instanceId: string
): Promise<unknown> {
	const result = await stopDurableRun(target, { mode, reason });
	// "stopping" = requested + persisted + converging async (slow-to-apply terminate);
	// the reaper finalizes. Only a genuine non-request failure is an error.
	if (!result.notFound && !result.confirmed && result.state !== 'stopping') {
		throw error(409, {
			message: `Durable ${mode} did not confirm closure of ${instanceId}`
		});
	}
	return result;
}

export async function runAgentRunOperation(
	agentRunIdOrInstanceId: string,
	operation: string,
	options: OperationOptions = {}
): Promise<unknown> {
	const agentRun = await findAgentRun(agentRunIdOrInstanceId);
	const instanceId = childRunInstanceId(agentRunIdOrInstanceId, agentRun);
	const encoded = encodeURIComponent(instanceId);
	switch (operation) {
		case 'terminate': {
			const target = await lifecycleTargetForInstance(instanceId);
			if (target) return stopThroughController(target, 'terminate', options.reason, instanceId);
			return (
				await agentJson(
					`/api/v2/agent-runs/${encoded}/terminate`,
					{ method: 'POST', body: JSON.stringify({ reason: options.reason }) },
					agentRun
				)
			).body;
		}
		case 'pause':
			return (await agentJson(`/api/v2/agent-runs/${encoded}/pause`, { method: 'POST' }, agentRun)).body;
		case 'resume':
			return (await agentJson(`/api/v2/agent-runs/${encoded}/resume`, { method: 'POST' }, agentRun)).body;
		case 'purge': {
			const target = await lifecycleTargetForInstance(instanceId);
			if (target) return stopThroughController(target, 'purge', options.reason, instanceId);
			const query = new URLSearchParams();
			if (options.force) query.set('force', 'true');
			if (options.recursive) query.set('recursive', 'true');
			const queryString = query.toString();
			return (
				await agentJson(
					`/api/v2/agent-runs/${encoded}${queryString ? `?${queryString}` : ''}`,
					{ method: 'DELETE' },
					agentRun
				)
			).body;
		}
		case 'rerun': {
			let overwriteInput = options.overwriteInput === true;
			let rerunInput = options.input ?? null;
			const eventId = Math.max(0, Math.trunc(options.fromEventId ?? 0));
			if (options.codeCheckpointId?.trim()) {
				const detail = await getWorkflowOpsAgentRun(agentRunIdOrInstanceId);
				const checkpoint = detail.codeCheckpoints.find(
					(candidate) => candidate.id === options.codeCheckpointId?.trim()
				);
				if (!checkpoint) {
					throw error(404, { message: 'Code checkpoint not found for this agent run' });
				}
				if (
					checkpoint.remoteStatus !== 'pushed' ||
					!checkpoint.remoteUrl ||
					!checkpoint.remoteRef ||
					!checkpoint.afterSha
				) {
					throw error(409, {
						message: 'Selected code checkpoint is not durable'
					});
				}
				const restore: Record<string, unknown> = {
					checkpointId: checkpoint.id,
					workflowExecutionId: checkpoint.workflowExecutionId,
					toolName: checkpoint.toolName,
					afterSha: checkpoint.afterSha,
					beforeSha: checkpoint.beforeSha,
					remoteUrl: checkpoint.remoteUrl,
					remoteRef: checkpoint.remoteRef,
					repoPath: checkpoint.repoPath
				};
				const sandboxName =
					options.restoreMode === 'fresh'
						? await createFreshReplaySandbox(`agent-replay-${checkpoint.id}`)
						: null;
				if (sandboxName) restore.restoreMode = 'fresh';
				const baseInput = overwriteInput
					? rerunInput
					: eventId > 0
						? replayEventInputFromHistory(detail.history, eventId)
						: sourceWorkflowInputFromHistory(detail.history);
				rerunInput = buildCodeCheckpointReplayInput(baseInput, restore, sandboxName);
				overwriteInput = true;
			}
			const body: Record<string, unknown> = {
				fromEventId: eventId,
				newInstanceId: options.newInstanceId,
				reason: options.reason,
				overwriteInput
			};
			if (overwriteInput) body.input = rerunInput;
			return (
				await agentJson(
					`/api/v2/agent-runs/${encoded}/rerun`,
					{ method: 'POST', body: JSON.stringify(body) },
					agentRun
				)
			).body;
		}
		default:
			throw error(404, { message: `Unknown agent run operation: ${operation}` });
	}
}

/**
 * Admin diagnostic surface (platform-admin-gated via /api/workflow-ops/*). For
 * terminate/purge we route through the vetted lifecycle controller whenever the
 * instance is DB-correlated (`lifecycleTargetForInstance`), so it gets cross-app
 * fan-out + fail-closed confirm + Sandbox reap + DB flip. KNOWN INTENTIONAL
 * BYPASS: for an UNCORRELATED raw instance id (no DB row — an operator poking a
 * specific Dapr instance), we fall back to raw orchestrator HTTP, which skips
 * fan-out/reap/DB-flip. pause/resume/event are always raw (durable-control verbs
 * outside the controller's stop contract). This is acceptable as an admin escape
 * hatch — user-facing stops never reach here; they use the /stop routes.
 */
export async function runWorkflowOperation(
	instanceId: string,
	operation: string,
	options: OperationOptions = {}
): Promise<unknown> {
	const encoded = encodeURIComponent(instanceId);
	switch (operation) {
		case 'terminate': {
			const target = await lifecycleTargetForInstance(instanceId);
			if (target) return stopThroughController(target, 'terminate', options.reason, instanceId);
			return orchestratorJson(`/api/v2/workflows/${encoded}/terminate`, {
				method: 'POST',
				body: JSON.stringify({ reason: options.reason })
			});
		}
		case 'pause':
			return orchestratorJson(`/api/v2/workflows/${encoded}/pause`, { method: 'POST' });
		case 'resume':
			return orchestratorJson(`/api/v2/workflows/${encoded}/resume`, { method: 'POST' });
		case 'purge': {
			const target = await lifecycleTargetForInstance(instanceId);
			if (target) return stopThroughController(target, 'purge', options.reason, instanceId);
			const query = new URLSearchParams();
			if (options.force) query.set('force', 'true');
			if (options.recursive) query.set('recursive', 'true');
			const queryString = query.toString();
			return orchestratorJson(`/api/v2/workflows/${encoded}${queryString ? `?${queryString}` : ''}`, {
				method: 'DELETE'
			});
		}
		case 'rerun': {
			let overwriteInput = options.overwriteInput === true;
			let rerunInput = options.input ?? null;
			const eventId = Math.max(0, Math.trunc(options.fromEventId ?? 0));
			if (options.codeCheckpointId?.trim()) {
				const detail = await getWorkflowOpsDetail(instanceId);
				if (!detail.execution?.id) {
					throw error(409, {
						message: 'A correlated workflow execution is required to restore a code checkpoint'
					});
				}
				const checkpoint = await getCodeCheckpoint(
					detail.execution.id,
					options.codeCheckpointId.trim()
				);
				if (!checkpoint) {
					throw error(404, { message: 'Code checkpoint not found' });
				}
				if (
					checkpoint.remoteStatus !== 'pushed' ||
					!checkpoint.remoteUrl ||
					!checkpoint.remoteRef ||
					!checkpoint.afterSha
				) {
					throw error(409, {
						message: 'Selected code checkpoint is not durable'
					});
				}
				const restore: Record<string, unknown> = {
					checkpointId: checkpoint.id,
					workflowExecutionId: checkpoint.workflowExecutionId,
					toolName: checkpoint.toolName,
					afterSha: checkpoint.afterSha,
					beforeSha: checkpoint.beforeSha,
					remoteUrl: checkpoint.remoteUrl,
					remoteRef: checkpoint.remoteRef,
					repoPath: checkpoint.repoPath
				};
				const sandboxName =
					options.restoreMode === 'fresh'
						? await createFreshReplaySandbox(`workflow-replay-${checkpoint.id}`)
						: null;
				if (sandboxName) restore.restoreMode = 'fresh';
				const baseInput = overwriteInput
					? rerunInput
					: eventId > 0
						? replayEventInputFromHistory(detail.history, eventId)
						: sourceWorkflowInputFromHistory(detail.history);
				rerunInput = buildCodeCheckpointReplayInput(baseInput, restore, sandboxName);
				overwriteInput = true;
			}
			const body: Record<string, unknown> = {
				fromEventId: eventId,
				newInstanceId: options.newInstanceId,
				reason: options.reason,
				overwriteInput
			};
			if (overwriteInput) body.input = rerunInput;
			return orchestratorJson(`/api/v2/workflows/${encoded}/rerun`, {
				method: 'POST',
				body: JSON.stringify(body)
			});
		}
		case 'event': {
			if (!options.eventName?.trim()) {
				throw error(400, { message: 'Event name is required' });
			}
			return orchestratorJson(`/api/v2/workflows/${encoded}/events`, {
				method: 'POST',
				body: JSON.stringify({
					eventName: options.eventName.trim(),
					eventData: options.eventData ?? {}
				})
			});
		}
		default:
			throw error(404, { message: `Unknown workflow operation: ${operation}` });
	}
}

export async function rerunWorkflowInstances(
	instanceIds: string[],
	options: Pick<OperationOptions, 'fromEventId' | 'overwriteInput' | 'input' | 'reason'> = {}
): Promise<{ results: Array<{ instanceId: string; newInstanceId?: string; success: boolean; error?: string }> }> {
	const results = [];
	for (const instanceId of instanceIds) {
		try {
			const result = (await runWorkflowOperation(instanceId, 'rerun', {
				...options,
				reason: options.reason ?? 'Bulk replay requested from Workflow Ops'
			})) as { newInstanceId?: string };
			results.push({ instanceId, newInstanceId: result.newInstanceId, success: true });
		} catch (err) {
			results.push({ instanceId, success: false, error: asErrorMessage(err) });
		}
	}
	return { results };
}

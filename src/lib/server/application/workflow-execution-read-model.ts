import type {
	WorkflowDataService,
	WorkflowExecutionAgentEventRecord,
	WorkflowExecutionAgentRunRecord,
	WorkflowExecutionLogRecord,
	WorkflowExecutionReadModelPort,
	WorkflowExecutionRecord,
	WorkflowRuntimeStatusPort,
	WorkflowRuntimeStatusSnapshot,
	WorkflowWorkspaceSessionRecord,
} from "$lib/server/application/ports";
import type {
	ExecutionReadModel,
	ExecutionStepLog,
	ExecutionTimelineEvent,
} from "$lib/types/execution-stream";
import {
	isLiteWorkflowInstanceId,
	LITE_WORKFLOW_NOT_EXECUTED_MESSAGE,
} from "$lib/server/application/lite-profile";

type ExecutionStatus = ExecutionReadModel["status"];

type SerializeExecutionReadModelOptions = {
	compact?: boolean;
	includeAgentEvents?: boolean;
};

export type ExecutionTraceExtractor = (value: unknown) => string[];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mapRuntimeStatus(
	runtimeStatus: string | null | undefined,
	fallback: ExecutionStatus,
): ExecutionStatus {
	switch ((runtimeStatus ?? "").toUpperCase()) {
		case "COMPLETED":
			return "success";
		case "FAILED":
			return "error";
		case "TERMINATED":
		case "CANCELED":
			return "cancelled";
		case "PENDING":
			return "pending";
		case "RUNNING":
		case "SUSPENDED":
			return "running";
		default:
			return fallback;
	}
}

export function isExecutionStatusTerminal(status: ExecutionStatus): boolean {
	return status === "success" || status === "error" || status === "cancelled";
}

/** A persisted terminal result is authoritative over the durable runtime envelope. */
export function resolveExecutionStatus(
	runtimeStatus: string | null | undefined,
	persistedStatus: ExecutionStatus,
): ExecutionStatus {
	return isExecutionStatusTerminal(persistedStatus)
		? persistedStatus
		: mapRuntimeStatus(runtimeStatus, persistedStatus);
}

function toIso(value: Date | string | null | undefined): string | null {
	if (!value) return null;
	if (value instanceof Date) return value.toISOString();
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function parseDurationMs(value: string | null): number | null {
	if (typeof value !== "string" || !value.trim()) return null;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : null;
}

function compactStepLog(step: ExecutionStepLog): ExecutionStepLog {
	return {
		...step,
		input: null,
		output: null,
	};
}

function buildNodeStatuses(
	steps: ExecutionStepLog[],
	currentNodeId: string | null,
	currentNodeName: string | null,
	status: ExecutionStatus,
) {
	const nodeStatuses: Record<string, string> = {};
	for (const step of steps) {
		nodeStatuses[step.stepName] = step.status;
	}

	const activeNode = currentNodeId || currentNodeName;
	if (activeNode && (status === "running" || status === "pending")) {
		nodeStatuses[activeNode] = "running";
	}

	return nodeStatuses;
}

function mapAgentEvent(row: WorkflowExecutionAgentEventRecord): ExecutionTimelineEvent {
	const data = isRecord(row.data) ? { ...row.data } : {};
	const toolName =
		typeof data.tool_name === "string"
			? data.tool_name
			: typeof data.toolName === "string"
				? data.toolName
				: typeof data.name === "string"
					? data.name
					: null;
	const phase = typeof data.phase === "string" ? data.phase : null;
	return {
		id: row.id,
		type: row.type,
		data,
		timestamp: row.createdAt.toISOString(),
		workflowAgentRunId: row.sessionId,
		daprInstanceId: row.sessionId,
		sourceEventId: row.sourceEventId,
		phase,
		toolName,
	};
}

function mapAgentRun(row: WorkflowExecutionAgentRunRecord): ExecutionReadModel["agentRuns"][number] {
	return {
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
		result: row.result ?? null,
		error: row.error ?? null,
		createdAt: toIso(row.createdAt),
		updatedAt: toIso(row.updatedAt),
		completedAt: toIso(row.completedAt),
	};
}

function mapWorkspace(row: WorkflowWorkspaceSessionRecord): ExecutionReadModel["workspaces"][number] {
	return {
		workspaceRef: row.workspaceRef,
		workflowExecutionId: row.workflowExecutionId,
		durableInstanceId: row.durableInstanceId ?? null,
		name: row.name,
		rootPath: row.rootPath ?? "",
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
		sandboxState: row.sandboxState ?? null,
	};
}

function mapStepLog(row: WorkflowExecutionLogRecord): ExecutionStepLog {
	return {
		logId: row.id,
		stepName: row.nodeId,
		label: row.nodeName,
		displayLabel: row.nodeName || row.nodeId,
		actionType: row.activityName ?? row.nodeType,
		status:
			row.status === "success" ||
			row.status === "error" ||
			row.status === "running" ||
			row.status === "pending"
				? row.status
				: "unknown",
		input: row.input,
		output: row.output,
		error: row.error,
		durationMs: parseDurationMs(row.duration),
		startedAt: toIso(row.startedAt),
		completedAt: toIso(row.completedAt),
	};
}

function mapStepLogs(rows: WorkflowExecutionLogRecord[]): ExecutionStepLog[] {
	const visibleRows = rows.filter((row) => !["trigger", "state"].includes(row.nodeId));
	const attemptsByNode = new Map<string, number>();
	const totalsByNode = new Map<string, number>();

	for (const row of visibleRows) {
		totalsByNode.set(row.nodeId, (totalsByNode.get(row.nodeId) ?? 0) + 1);
	}

	return visibleRows.map((row) => {
		const attempt = (attemptsByNode.get(row.nodeId) ?? 0) + 1;
		attemptsByNode.set(row.nodeId, attempt);
		const attemptsTotal = totalsByNode.get(row.nodeId) ?? 1;
		const step = mapStepLog(row);
		const baseLabel = row.nodeName || row.nodeId;
		return {
			...step,
			displayLabel:
				attemptsTotal > 1 ? `${baseLabel} (attempt ${attempt})` : baseLabel,
			attempt,
			attemptsTotal,
		};
	});
}

export class ApplicationWorkflowExecutionReadModelService
	implements WorkflowExecutionReadModelPort
{
	constructor(
		private readonly deps: {
			workflowData: Pick<
				WorkflowDataService,
				| "assertExecutionReadModelReady"
				| "getExecutionById"
				| "updateExecutionReadModel"
				| "listExecutionLogs"
				| "listRecentExecutionAgentEvents"
				| "listWorkflowAgentRunsByExecutionId"
				| "listWorkflowWorkspaceSessionsByExecutionId"
				| "listWorkflowBrowserArtifactsByExecutionId"
				| "listWorkflowArtifactsByExecutionId"
			>;
			runtimeStatus: WorkflowRuntimeStatusPort;
			traceExtractor: ExecutionTraceExtractor;
		},
	) {}

	async loadExecutionReadModel(input: {
		executionId: string;
		refreshRuntime: boolean;
		includeAgentEvents: boolean;
	}): Promise<ExecutionReadModel | null> {
		let execution = await this.readExecutionRow(input.executionId);
		if (!execution) return null;

		const runtime = input.refreshRuntime
			? await this.refreshExecutionRuntime(execution)
			: null;
		if (runtime) {
			execution = (await this.readExecutionRow(input.executionId)) ?? execution;
		}

		const [steps, browserArtifacts, agentRuns, workspaces, agentEvents, traceIds, artifacts] =
			await Promise.all([
				this.readExecutionSteps(input.executionId),
				this.deps.workflowData.listWorkflowBrowserArtifactsByExecutionId(input.executionId),
				this.deps.workflowData
					.listWorkflowAgentRunsByExecutionId(input.executionId)
					.then((rows) => rows.map(mapAgentRun)),
				this.deps.workflowData
					.listWorkflowWorkspaceSessionsByExecutionId({
						executionId: input.executionId,
						limit: 50,
						order: "asc",
					})
					.then((rows) => rows.map(mapWorkspace)),
				input.includeAgentEvents
					? this.deps.workflowData
							.listRecentExecutionAgentEvents({
								executionId: input.executionId,
								limit: 200,
							})
							.then((rows) => rows.map(mapAgentEvent))
					: Promise.resolve([]),
				this.readTraceIds(execution),
				this.deps.workflowData.listWorkflowArtifactsByExecutionId(input.executionId),
			]);

		const lastAgentEventId = agentEvents.at(-1)?.id ?? 0;
		const runtimeStatus = runtime?.runtimeStatus ?? null;
		const traceId = runtime?.traceId ?? execution.primaryTraceId ?? traceIds[0] ?? null;
		const output = execution.output ?? runtime?.outputs ?? null;
		const nodeStatuses = buildNodeStatuses(
			steps,
			execution.currentNodeId,
			execution.currentNodeName,
			execution.status,
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
			input: execution.input ?? null,
			output,
			summaryOutput: execution.summaryOutput ?? null,
			error: runtime?.error ?? execution.error,
			startedAt: toIso(execution.startedAt),
			completedAt: toIso(execution.completedAt) ?? runtime?.completedAt ?? null,
			nodeStatuses,
			steps,
			browserArtifacts: browserArtifacts as unknown as Array<Record<string, unknown>>,
			agentRuns,
			workspaces,
			agentEvents,
			lastAgentEventId,
			artifacts: artifacts.map((artifact) => ({
				...artifact,
				createdAt: artifact.createdAt.toISOString(),
			})),
		};
	}

	serializeExecutionReadModel(
		model: unknown,
		options?: SerializeExecutionReadModelOptions,
	): Record<string, unknown> {
		const readModel = model as ExecutionReadModel;
		const includeAgentEvents = options?.includeAgentEvents ?? false;
		const compact = options?.compact ?? false;
		const shouldCompact = compact && !isExecutionStatusTerminal(readModel.status);

		return {
			...readModel,
			output: shouldCompact ? readModel.summaryOutput ?? null : readModel.output,
			steps: shouldCompact ? readModel.steps.map((step) => compactStepLog(step)) : readModel.steps,
			agentRuns: readModel.agentRuns,
			agentEvents: includeAgentEvents ? readModel.agentEvents : [],
		};
	}

	private async readExecutionRow(executionId: string): Promise<WorkflowExecutionRecord | null> {
		await this.deps.workflowData.assertExecutionReadModelReady();
		return this.deps.workflowData.getExecutionById(executionId);
	}

	private async readExecutionSteps(executionId: string): Promise<ExecutionStepLog[]> {
		const rows = await this.deps.workflowData.listExecutionLogs(executionId);
		return mapStepLogs(rows);
	}

	private async readTraceIds(execution: WorkflowExecutionRecord) {
		const traceIds = new Set<string>();
		if (execution.primaryTraceId?.trim()) traceIds.add(execution.primaryTraceId.trim());
		for (const traceId of this.deps.traceExtractor(execution.output)) {
			traceIds.add(traceId);
		}

		const events = await this.deps.workflowData.listRecentExecutionAgentEvents({
			executionId: execution.id,
			limit: 200,
		});
		for (const row of events) {
			const traceId =
				row.data && typeof row.data.traceId === "string" ? row.data.traceId.trim() : "";
			if (traceId) traceIds.add(traceId);
		}

		return Array.from(traceIds);
	}

	private async refreshExecutionRuntime(
		execution: WorkflowExecutionRecord,
	): Promise<WorkflowRuntimeStatusSnapshot | null> {
		if (!execution.daprInstanceId) return null;
		if (execution.status !== "running" && execution.status !== "pending") return null;

		// Lite profile: the scheduler is an honest stub — nothing was scheduled.
		// Surface a clear terminal state instead of polling a non-existent
		// orchestrator (which would leave the run stuck in "running" forever).
		if (isLiteWorkflowInstanceId(execution.daprInstanceId)) {
			const completedAt = execution.completedAt ?? new Date();
			await this.deps.workflowData.updateExecutionReadModel(execution.id, {
				status: "error",
				error: LITE_WORKFLOW_NOT_EXECUTED_MESSAGE,
				completedAt,
			});
			return {
				runtimeStatus: "FAILED",
				phase: execution.phase,
				progress: execution.progress,
				currentNodeId: execution.currentNodeId,
				currentNodeName: execution.currentNodeName,
				traceId: null,
				outputs: null,
				error: LITE_WORKFLOW_NOT_EXECUTED_MESSAGE,
				completedAt: toIso(completedAt),
			};
		}

		try {
			const runtime = await this.deps.runtimeStatus.getWorkflowStatus(
				execution.daprInstanceId,
			);
			if (!runtime) return null;
			const nextStatus = resolveExecutionStatus(runtime.runtimeStatus, execution.status);
			const nextCompletedAt =
				typeof runtime.completedAt === "string"
					? new Date(runtime.completedAt)
					: isExecutionStatusTerminal(nextStatus) && !execution.completedAt
						? new Date()
						: execution.completedAt;
			const patch = {
				status: nextStatus,
				phase: runtime.phase ?? execution.phase,
				progress: runtime.progress ?? execution.progress,
				currentNodeId: runtime.currentNodeId ?? execution.currentNodeId,
				currentNodeName: runtime.currentNodeName ?? execution.currentNodeName,
				primaryTraceId: runtime.traceId ?? execution.primaryTraceId,
				error: runtime.error ?? execution.error,
				completedAt: nextCompletedAt,
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

			if (changed) {
				await this.deps.workflowData.updateExecutionReadModel(execution.id, patch);
			}

			return runtime;
		} catch {
			return null;
		}
	}
}

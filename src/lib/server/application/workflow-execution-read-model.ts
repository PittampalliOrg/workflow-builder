import type {
	WorkflowDataService,
	WorkflowExecutionAgentEventRecord,
	WorkflowExecutionAgentRunRecord,
	WorkflowExecutionLogRecord,
	WorkflowExecutionReadModelPort,
	WorkflowExecutionRecord,
	WorkflowExecutionStatus,
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

type ExecutionStatus = WorkflowExecutionStatus;

export type WorkflowExecutionStatusSnapshot = Pick<
	WorkflowExecutionRecord,
	"status" | "phase" | "progress" | "output" | "error" | "completedAt"
>;

type WorkflowExecutionStatusAuthoritySnapshot = WorkflowExecutionStatusSnapshot &
	Partial<Pick<WorkflowExecutionRecord, "stopReason">>;

export type WorkflowRuntimeExecutionStatusSnapshot = Pick<
	WorkflowRuntimeStatusSnapshot,
	"runtimeStatus" | "phase" | "progress" | "outputs" | "error" | "completedAt"
>;

type NormalizedRuntimeStatus =
	| "FAILED"
	| "TERMINATED"
	| "CANCELED"
	| "COMPLETED"
	| "PENDING"
	| "RUNNING"
	| "SUSPENDED";

export type ResolvedWorkflowExecutionStatusSnapshot = {
	snapshot: WorkflowExecutionStatusSnapshot;
	patch: WorkflowExecutionStatusSnapshot | null;
};

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
	switch (normalizeRuntimeStatus(runtimeStatus)) {
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

/** Resolve the explicit precedence between a persisted result and the runtime lifecycle. */
export function resolveExecutionStatus(
	runtimeStatus: string | null | undefined,
	persistedStatus: ExecutionStatus,
): ExecutionStatus {
	switch (normalizeRuntimeStatus(runtimeStatus)) {
		case "FAILED":
			return "error";
		case "TERMINATED":
		case "CANCELED":
			return "cancelled";
		case "COMPLETED":
			return isExecutionStatusTerminal(persistedStatus) ? persistedStatus : "success";
		case "PENDING":
			return isExecutionStatusTerminal(persistedStatus) ? persistedStatus : "pending";
		case "RUNNING":
		case "SUSPENDED":
			return isExecutionStatusTerminal(persistedStatus) ? persistedStatus : "running";
		default:
			return persistedStatus;
	}
}

function normalizeRuntimeStatus(
	runtimeStatus: string | null | undefined,
): NormalizedRuntimeStatus | null {
	switch ((runtimeStatus ?? "").trim().toUpperCase()) {
		case "FAILED":
		case "TERMINATED":
		case "CANCELED":
		case "COMPLETED":
		case "PENDING":
		case "RUNNING":
		case "SUSPENDED":
			return (runtimeStatus ?? "").trim().toUpperCase() as NormalizedRuntimeStatus;
		default:
			return null;
	}
}

export function workflowExecutionStatusSnapshotFromRecord(
	persisted: WorkflowExecutionStatusSnapshot,
): WorkflowExecutionStatusSnapshot {
	return {
		status: persisted.status,
		phase: persisted.phase,
		progress: persisted.progress,
		output: persisted.output,
		error: persisted.error,
		completedAt: persisted.completedAt,
	};
}

function terminalPhase(status: ExecutionStatus): string | null {
	switch (status) {
		case "success":
			return "completed";
		case "error":
			return "failed";
		case "cancelled":
			return "cancelled";
		default:
			return null;
	}
}

function parseRuntimeCompletedAt(value: string | null): Date | null {
	if (!value) return null;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

export function resolveExecutionStatusSnapshot(
	input: {
		persisted: WorkflowExecutionStatusAuthoritySnapshot;
		runtime: WorkflowRuntimeExecutionStatusSnapshot | null | undefined;
		observedAt: Date;
	},
): ResolvedWorkflowExecutionStatusSnapshot {
	const { persisted, runtime, observedAt } = input;
	const current = workflowExecutionStatusSnapshotFromRecord(persisted);
	if (!runtime || !normalizeRuntimeStatus(runtime.runtimeStatus)) {
		return { snapshot: current, patch: null };
	}
	if (persisted.status === "cancelled" && persisted.stopReason?.trim()) {
		return { snapshot: current, patch: null };
	}

	const status = resolveExecutionStatus(runtime.runtimeStatus, persisted.status);
	if (isExecutionStatusTerminal(persisted.status) && status === persisted.status) {
		return { snapshot: current, patch: null };
	}
	const terminal = isExecutionStatusTerminal(status);
	const snapshot: WorkflowExecutionStatusSnapshot = terminal
		? {
				status,
				phase: terminalPhase(status),
				progress: 100,
				output: persisted.output ?? runtime.outputs ?? null,
				error:
					status === "success"
						? null
						: status === "cancelled"
							? (persisted.error ?? runtime.error)
							: (runtime.error ?? persisted.error),
				completedAt:
					persisted.completedAt ?? parseRuntimeCompletedAt(runtime.completedAt) ?? observedAt,
			}
		: {
				status,
				phase: runtime.phase ?? persisted.phase,
				progress: runtime.progress ?? persisted.progress,
				output: persisted.output ?? runtime.outputs ?? null,
				error: runtime.error ?? persisted.error,
				completedAt: null,
			};

	return {
		snapshot,
		patch: executionStatusSnapshotChanged(persisted, snapshot) ? snapshot : null,
	};
}

function executionStatusSnapshotChanged(
	persisted: WorkflowExecutionStatusSnapshot,
	effective: WorkflowExecutionStatusSnapshot,
): boolean {
	return (
		effective.status !== persisted.status ||
		effective.phase !== persisted.phase ||
		effective.progress !== persisted.progress ||
		effective.output !== persisted.output ||
		effective.error !== persisted.error ||
		(effective.completedAt?.getTime() ?? null) !== (persisted.completedAt?.getTime() ?? null)
	);
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
				| "compareAndSetExecutionReadModel"
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

		const refresh = input.refreshRuntime
			? await this.refreshExecutionRuntime(execution)
			: null;
		const runtime = refresh?.runtime ?? null;
		if (refresh) {
			if (!refresh.execution) return null;
			execution = refresh.execution;
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
		const terminal = isExecutionStatusTerminal(execution.status);
		const output = terminal ? execution.output : (execution.output ?? runtime?.outputs ?? null);
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
			error: terminal ? execution.error : (runtime?.error ?? execution.error),
			startedAt: toIso(execution.startedAt),
			completedAt: terminal
				? toIso(execution.completedAt)
				: (toIso(execution.completedAt) ?? runtime?.completedAt ?? null),
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
	): Promise<{
		runtime: WorkflowRuntimeStatusSnapshot;
		execution: WorkflowExecutionRecord | null;
	} | null> {
		if (!execution.daprInstanceId) return null;
		if (execution.status !== "running" && execution.status !== "pending") return null;

		// Lite profile: the scheduler is an honest stub — nothing was scheduled.
		// Surface a clear terminal state instead of polling a non-existent
		// orchestrator (which would leave the run stuck in "running" forever).
		if (isLiteWorkflowInstanceId(execution.daprInstanceId)) {
			const completedAt = execution.completedAt ?? new Date();
			const winner = await this.deps.workflowData.compareAndSetExecutionReadModel({
				executionId: execution.id,
				expectedStatus: execution.status,
				patch: {
					status: "error",
					phase: "failed",
					progress: 100,
					error: LITE_WORKFLOW_NOT_EXECUTED_MESSAGE,
					completedAt,
				},
			});
			return {
				execution: winner,
				runtime: {
					runtimeStatus: "FAILED",
					phase: execution.phase,
					progress: execution.progress,
					currentNodeId: execution.currentNodeId,
					currentNodeName: execution.currentNodeName,
					traceId: null,
					outputs: null,
					error: LITE_WORKFLOW_NOT_EXECUTED_MESSAGE,
					completedAt: toIso(completedAt),
				},
			};
		}

		try {
			const runtime = await this.deps.runtimeStatus.getWorkflowStatus(
				execution.daprInstanceId,
			);
			if (!runtime) return null;
			const statusResolution = resolveExecutionStatusSnapshot({
				persisted: execution,
				runtime,
				observedAt: new Date(),
			});
			const runtimeFields = {
				currentNodeId: runtime.currentNodeId ?? execution.currentNodeId,
				currentNodeName: runtime.currentNodeName ?? execution.currentNodeName,
				primaryTraceId: runtime.traceId ?? execution.primaryTraceId,
			};
			const runtimeFieldsChanged =
				runtimeFields.currentNodeId !== execution.currentNodeId ||
				runtimeFields.currentNodeName !== execution.currentNodeName ||
				runtimeFields.primaryTraceId !== execution.primaryTraceId;

			let winner: WorkflowExecutionRecord | null = execution;
			if (statusResolution.patch || runtimeFieldsChanged) {
				winner = await this.deps.workflowData.compareAndSetExecutionReadModel({
					executionId: execution.id,
					expectedStatus: execution.status,
					patch: {
						...(statusResolution.patch ?? {}),
						...runtimeFields,
					},
				});
			}

			return { runtime, execution: winner };
		} catch {
			return null;
		}
	}
}

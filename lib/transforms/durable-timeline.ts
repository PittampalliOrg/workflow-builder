import type {
	GenericWorkflowHistoryEvent,
	GenericWorkflowStatus,
} from "@/lib/dapr-client";
import type {
	DurableAgentRunSummary,
	DurableExecutionConsistency,
	DurableExternalEventSummary,
	DurablePlanArtifactSummary,
	DurableRuntimeSnapshot,
	DurableTimelineEvent,
	DurableTimelineEventKind,
} from "@/lib/types/durable-timeline";

type ExecutionLike = {
	id: string;
	status: string;
	phase: string | null;
	startedAt: Date | string;
	completedAt: Date | string | null;
	error: string | null;
};

type ExecutionLogLike = {
	id: string;
	nodeId: string;
	nodeName: string;
	activityName: string | null;
	status: string;
	input: unknown;
	output: unknown;
	error: string | null;
	startedAt: Date | string;
	completedAt: Date | string | null;
	timestamp: Date | string;
	duration: string | null;
	executionMs?: number | null;
};

type ExternalEventLike = {
	id: string;
	nodeId: string;
	eventName: string;
	eventType: string;
	approved: boolean | null;
	reason: string | null;
	respondedBy: string | null;
	requestedAt: Date | string | null;
	respondedAt: Date | string | null;
	expiresAt: Date | string | null;
	createdAt: Date | string;
	payload: unknown;
};

type PlanArtifactLike = {
	id: string;
	nodeId: string;
	status: string;
	artifactType: string;
	artifactVersion: number;
	goal: string;
	workspaceRef: string | null;
	clonePath: string | null;
	createdAt: Date | string;
	updatedAt: Date | string;
	metadata: Record<string, unknown> | null;
};

type AgentRunLike = {
	id: string;
	nodeId: string;
	mode: string;
	status: string;
	agentWorkflowId: string;
	daprInstanceId: string;
	parentExecutionId: string;
	workspaceRef: string | null;
	artifactRef: string | null;
	createdAt: Date | string;
	completedAt: Date | string | null;
	eventPublishedAt: Date | string | null;
	lastReconciledAt: Date | string | null;
	error: string | null;
	result: unknown;
};

type BuildTimelineInput = {
	execution: ExecutionLike;
	orchestratorHistory?: GenericWorkflowHistoryEvent[] | null;
	logs: ExecutionLogLike[];
	externalEvents: ExternalEventLike[];
	planArtifacts: PlanArtifactLike[];
	agentRuns: AgentRunLike[];
};

type DeriveAgentRunsInput = {
	executionId: string;
	parentExecutionId: string;
	logs: ExecutionLogLike[];
	orchestratorHistory?: GenericWorkflowHistoryEvent[] | null;
};

const SOURCE_ORDER: Record<string, number> = {
	orchestrator_history: 1,
	execution_log: 2,
	external_event: 3,
	plan_artifact: 4,
	agent_run: 5,
	db_fallback: 6,
};

function toIso(value: Date | string | null | undefined): string | null {
	if (!value) {
		return null;
	}
	const parsed = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		return null;
	}
	return parsed.toISOString();
}

function parseDurationMs(
	value: string | number | null | undefined,
): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value !== "string") {
		return null;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) ? null : parsed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

function getNestedRecord(
	root: Record<string, unknown>,
	keys: string[],
): Record<string, unknown> | null {
	for (const key of keys) {
		const nested = asRecord(root[key]);
		if (nested) {
			return nested;
		}
	}
	return null;
}

function getStringField(
	root: Record<string, unknown>,
	keys: string[],
): string | null {
	for (const key of keys) {
		const value = root[key];
		if (typeof value === "string") {
			const trimmed = value.trim();
			if (trimmed.length > 0) {
				return trimmed;
			}
		}
	}
	return null;
}

function parseActivityMode(
	activityName: string | null | undefined,
): "run" | "plan" | "execute_plan" {
	const normalized = (activityName ?? "").toLowerCase();
	if (normalized.includes("execute_plan")) {
		return "execute_plan";
	}
	if (
		normalized.includes("durable/plan") ||
		normalized.includes("call_durable_plan")
	) {
		return "plan";
	}
	return "run";
}

function mapLogStatusToRunStatus(
	status: string,
): "scheduled" | "completed" | "failed" {
	if (status === "error") {
		return "failed";
	}
	if (status === "success") {
		return "completed";
	}
	return "scheduled";
}

function parseEventSuccess(event: GenericWorkflowHistoryEvent): boolean | null {
	const inputRecord = asRecord(event.input);
	if (!inputRecord) {
		return null;
	}
	const success = inputRecord.success;
	if (typeof success === "boolean") {
		return success;
	}
	return null;
}

function parseEventError(event: GenericWorkflowHistoryEvent): string | null {
	const inputRecord = asRecord(event.input);
	if (!inputRecord) {
		return null;
	}
	const error = inputRecord.error;
	if (typeof error === "string" && error.trim().length > 0) {
		return error.trim();
	}
	return null;
}

function parseEventResult(event: GenericWorkflowHistoryEvent): unknown {
	const inputRecord = asRecord(event.input);
	if (!inputRecord) {
		return undefined;
	}
	return inputRecord.result;
}

type PendingRunCandidate = {
	ts: string;
	mode: "run" | "plan" | "execute_plan";
};

function deriveModeFromHistoryTaskName(
	name: string | null | undefined,
): PendingRunCandidate["mode"] | null {
	const normalized = (name ?? "").trim();
	if (!normalized) {
		return null;
	}
	if (normalized === "call_durable_execute_plan") {
		return "execute_plan";
	}
	if (normalized === "call_durable_plan") {
		return "plan";
	}
	if (normalized === "call_durable_agent_run") {
		return "run";
	}
	return null;
}

export function deriveDurableAgentRuns(
	input: DeriveAgentRunsInput,
): DurableAgentRunSummary[] {
	const runMap = new Map<string, DurableAgentRunSummary>();

	for (const log of input.logs) {
		const activityName = (log.activityName ?? "").toLowerCase();
		if (
			!(
				activityName.includes("durable/") ||
				activityName.includes("mastra/execute")
			)
		) {
			continue;
		}

		const outputRecord = asRecord(log.output);
		const nested = outputRecord
			? getNestedRecord(outputRecord, ["result", "data"])
			: null;
		const candidates = [outputRecord, nested].filter(
			(item): item is Record<string, unknown> => Boolean(item),
		);

		let agentWorkflowId: string | null = null;
		let daprInstanceId: string | null = null;
		for (const candidate of candidates) {
			agentWorkflowId =
				agentWorkflowId ??
				getStringField(candidate, [
					"agentWorkflowId",
					"agent_workflow_id",
					"workflow_id",
					"workflowId",
				]);
			daprInstanceId =
				daprInstanceId ??
				getStringField(candidate, [
					"daprInstanceId",
					"dapr_instance_id",
					"instanceId",
					"workflow_instance_id",
				]);
		}

		const createdAt =
			toIso(log.startedAt ?? log.timestamp) ?? new Date(0).toISOString();
		const completedAt =
			log.status === "success" || log.status === "error"
				? toIso(log.completedAt ?? log.timestamp)
				: null;
		const mode = parseActivityMode(log.activityName);
		const runId =
			agentWorkflowId ??
			daprInstanceId ??
			`${input.executionId}:${log.nodeId}:${createdAt}:${mode}`;

		runMap.set(runId, {
			id: runId,
			nodeId: log.nodeId,
			mode,
			status: mapLogStatusToRunStatus(log.status),
			agentWorkflowId: agentWorkflowId ?? runId,
			daprInstanceId: daprInstanceId ?? agentWorkflowId ?? runId,
			parentExecutionId: input.parentExecutionId,
			workspaceRef: null,
			artifactRef: null,
			createdAt,
			completedAt,
			eventPublishedAt: null,
			lastReconciledAt: null,
			error: log.error,
			result: log.output,
		});
	}

	const pendingByMode = new Map<
		PendingRunCandidate["mode"],
		PendingRunCandidate[]
	>();
	const history = input.orchestratorHistory ?? [];
	const sortedHistory = [...history].sort((a, b) => {
		const ta = toIso(a.timestamp) ?? new Date(0).toISOString();
		const tb = toIso(b.timestamp) ?? new Date(0).toISOString();
		return new Date(ta).getTime() - new Date(tb).getTime();
	});

	for (const event of sortedHistory) {
		const eventTs = toIso(event.timestamp);
		if (!eventTs) {
			continue;
		}
		if (event.eventType === "TaskScheduled") {
			const mode = deriveModeFromHistoryTaskName(event.name);
			if (!mode) {
				continue;
			}
			const queue = pendingByMode.get(mode) ?? [];
			queue.push({ ts: eventTs, mode });
			pendingByMode.set(mode, queue);
			continue;
		}

		if (event.eventType !== "EventRaised") {
			continue;
		}

		const eventName = (event.name ?? "").trim();
		if (!eventName.startsWith("agent_completed_")) {
			continue;
		}

		const runId = eventName.slice("agent_completed_".length);
		if (!runId) {
			continue;
		}

		const success = parseEventSuccess(event);
		const status = success === false ? "failed" : "completed";
		const error = parseEventError(event);
		const result = parseEventResult(event);

		const existing = runMap.get(runId);
		if (existing) {
			runMap.set(runId, {
				...existing,
				status,
				completedAt: eventTs,
				error: error ?? existing.error,
				result: result ?? existing.result,
			});
			continue;
		}

		const syntheticPrefix = `${input.executionId}:`;
		const mergeCandidate = Array.from(runMap.values()).find((run) => {
			if (!run.id.startsWith(syntheticPrefix)) {
				return false;
			}
			const modeMatches = run.mode === "run" || run.mode === "execute_plan";
			if (!modeMatches) {
				return false;
			}
			const completedAt = run.completedAt ?? run.createdAt;
			const delta = Math.abs(
				new Date(completedAt).getTime() - new Date(eventTs).getTime(),
			);
			return Number.isFinite(delta) && delta <= 2 * 60 * 1000;
		});
		if (mergeCandidate) {
			runMap.delete(mergeCandidate.id);
			runMap.set(runId, {
				...mergeCandidate,
				id: runId,
				agentWorkflowId: runId,
				daprInstanceId: runId,
				status,
				completedAt: eventTs,
				eventPublishedAt: eventTs,
				error: error ?? mergeCandidate.error,
				result: result ?? mergeCandidate.result,
			});
			continue;
		}

		const queueOrder: PendingRunCandidate["mode"][] = [
			"run",
			"execute_plan",
			"plan",
		];
		let queued: PendingRunCandidate | undefined;
		for (const mode of queueOrder) {
			const queue = pendingByMode.get(mode);
			if (queue && queue.length > 0) {
				queued = queue.shift();
				break;
			}
		}

		runMap.set(runId, {
			id: runId,
			nodeId: "unknown",
			mode: queued?.mode ?? "run",
			status,
			agentWorkflowId: runId,
			daprInstanceId: runId,
			parentExecutionId: input.parentExecutionId,
			workspaceRef: null,
			artifactRef: null,
			createdAt: queued?.ts ?? eventTs,
			completedAt: eventTs,
			eventPublishedAt: eventTs,
			lastReconciledAt: null,
			error,
			result,
		});
	}

	return Array.from(runMap.values()).sort(
		(a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
	);
}

function approvalEventName(name: string | null | undefined): boolean {
	const value = (name ?? "").toLowerCase();
	return value.includes("approval");
}

function kindForLogStatus(status: string): DurableTimelineEventKind {
	switch (status) {
		case "pending":
			return "node_scheduled";
		case "running":
			return "node_started";
		case "success":
			return "node_completed";
		case "error":
			return "node_failed";
		default:
			return "node_completed";
	}
}

function kindForRuntimeCompletion(status: string): DurableTimelineEventKind {
	return status === "success" ? "workflow_completed" : "workflow_failed";
}

export function mapRuntimeStatusToLocalStatus(input: {
	runtimeStatus: string;
	phase?: string | null;
	message?: string | null;
	outputs?: Record<string, unknown>;
	error?: string | null;
	fallbackStatus?: string;
}): {
	status: "pending" | "running" | "success" | "error" | "cancelled";
	error: string | null;
} {
	const runtime = input.runtimeStatus.toUpperCase();
	const phase = (input.phase ?? "").toLowerCase();
	const outputSuccess = input.outputs?.success;
	const outputError =
		typeof input.outputs?.error === "string" ? input.outputs.error : null;
	const message = input.message ?? null;
	const runtimeError = input.error ?? null;

	if (runtime === "COMPLETED") {
		if (phase === "failed" || outputSuccess === false) {
			return {
				status: "error",
				error: runtimeError ?? message ?? outputError ?? "Workflow failed",
			};
		}
		return { status: "success", error: null };
	}

	if (runtime === "FAILED") {
		return {
			status: "error",
			error: runtimeError ?? message ?? outputError ?? "Workflow failed",
		};
	}

	if (runtime === "TERMINATED" || runtime === "CANCELED") {
		return {
			status: "cancelled",
			error: runtimeError ?? message ?? outputError ?? "Workflow cancelled",
		};
	}

	if (runtime === "PENDING") {
		return { status: "pending", error: null };
	}

	if (runtime === "UNKNOWN") {
		if (phase === "completed" || outputSuccess === true) {
			return { status: "success", error: null };
		}
		if (phase === "failed" || outputSuccess === false) {
			return {
				status: "error",
				error: runtimeError ?? message ?? outputError ?? "Workflow failed",
			};
		}
	}

	const fallback = input.fallbackStatus;
	if (
		fallback === "pending" ||
		fallback === "running" ||
		fallback === "success"
	) {
		return { status: fallback, error: runtimeError ?? null };
	}
	if (fallback === "cancelled") {
		return { status: "cancelled", error: runtimeError ?? null };
	}
	if (fallback === "error") {
		return { status: "error", error: runtimeError ?? message ?? null };
	}

	return { status: "running", error: runtimeError ?? null };
}

export function toDurableRuntimeSnapshot(
	status: GenericWorkflowStatus | null | undefined,
): DurableRuntimeSnapshot | null {
	if (!status) {
		return null;
	}
	return {
		runtimeStatus: status.runtimeStatus,
		phase: status.phase ?? null,
		progress: typeof status.progress === "number" ? status.progress : null,
		message: status.message ?? null,
		currentNodeId: status.currentNodeId ?? null,
		currentNodeName: status.currentNodeName ?? null,
		approvalEventName: status.approvalEventName ?? null,
		traceId: status.traceId ?? null,
		startedAt: status.startedAt ?? null,
		completedAt: status.completedAt ?? null,
		outputs: status.outputs,
		error: status.error ?? null,
	};
}

export function buildExecutionConsistency(input: {
	dbStatus: string;
	dbPhase: string | null;
	runtime: DurableRuntimeSnapshot | null;
}): DurableExecutionConsistency {
	const notes: string[] = [];
	if (!input.runtime) {
		notes.push("runtime_unavailable_using_db");
		return {
			statusDiverged: false,
			dbStatus: input.dbStatus,
			runtimeStatus: null,
			dbPhase: input.dbPhase,
			runtimePhase: null,
			notes,
		};
	}

	const mapped = mapRuntimeStatusToLocalStatus({
		runtimeStatus: input.runtime.runtimeStatus,
		phase: input.runtime.phase,
		message: input.runtime.message,
		outputs: input.runtime.outputs,
		error: input.runtime.error,
		fallbackStatus: input.dbStatus,
	});

	if (mapped.status !== input.dbStatus) {
		notes.push("status_mismatch_db_vs_runtime");
	}
	if ((input.runtime.phase ?? null) !== (input.dbPhase ?? null)) {
		notes.push("phase_mismatch_db_vs_runtime");
	}

	return {
		statusDiverged: notes.length > 0,
		dbStatus: input.dbStatus,
		runtimeStatus: input.runtime.runtimeStatus,
		dbPhase: input.dbPhase,
		runtimePhase: input.runtime.phase,
		notes,
	};
}

function mapOrchestratorEvent(
	event: GenericWorkflowHistoryEvent,
	index: number,
): DurableTimelineEvent | null {
	const ts = toIso(event.timestamp ?? null);
	if (!ts) {
		return null;
	}

	const eventType = event.eventType;
	if (eventType === "OrchestratorStarted") {
		return {
			id: `hist-start-${index}`,
			ts,
			kind: "workflow_started",
			source: "orchestrator_history",
			label: "Workflow started",
			input: event.input,
			output: event.output,
			refs: {
				eventType,
				eventId: event.eventId ?? null,
				name: event.name ?? null,
			},
		};
	}

	if (eventType === "TaskScheduled") {
		const taskId =
			typeof event.metadata?.taskId === "string" ? event.metadata.taskId : null;
		return {
			id: `hist-scheduled-${index}`,
			ts,
			kind: "node_scheduled",
			source: "orchestrator_history",
			status: "pending",
			nodeId: taskId,
			nodeName: event.name ?? taskId,
			label: event.name ?? "Task scheduled",
			input: event.input,
			output: event.output,
			refs: { eventType, eventId: event.eventId ?? null },
		};
	}

	if (eventType === "TaskCompleted") {
		const status =
			typeof event.metadata?.status === "string"
				? event.metadata.status
				: "success";
		const failed = status === "error" || status === "failed";
		const taskId =
			typeof event.metadata?.taskId === "string" ? event.metadata.taskId : null;
		return {
			id: `hist-completed-${index}`,
			ts,
			kind: failed ? "node_failed" : "node_completed",
			source: "orchestrator_history",
			status,
			nodeId: taskId,
			nodeName: event.name ?? taskId,
			label: event.name ?? "Task completed",
			input: event.input,
			output: event.output,
			refs: { eventType, eventId: event.eventId ?? null },
		};
	}

	if (eventType === "EventRaised") {
		const isApproval = approvalEventName(event.name);
		return {
			id: `hist-event-${index}`,
			ts,
			kind: isApproval ? "approval_responded" : "node_started",
			source: "orchestrator_history",
			label: event.name ?? "External event raised",
			input: event.input,
			output: event.output,
			refs: { eventType, eventId: event.eventId ?? null },
		};
	}

	if (eventType === "ExecutionCompleted") {
		const status =
			typeof event.metadata?.status === "string"
				? event.metadata.status.toLowerCase()
				: "completed";
		const failed = status === "failed" || status === "error";
		return {
			id: `hist-finish-${index}`,
			ts,
			kind: failed ? "workflow_failed" : "workflow_completed",
			source: "orchestrator_history",
			status,
			label: failed ? "Workflow failed" : "Workflow completed",
			input: event.input,
			output: event.output,
			refs: { eventType, eventId: event.eventId ?? null },
		};
	}

	return null;
}

export function toDurableAgentRunSummary(
	runs: AgentRunLike[],
): DurableAgentRunSummary[] {
	return runs.map((run) => ({
		id: run.id,
		nodeId: run.nodeId,
		mode: run.mode,
		status: run.status,
		agentWorkflowId: run.agentWorkflowId,
		daprInstanceId: run.daprInstanceId,
		parentExecutionId: run.parentExecutionId,
		workspaceRef: run.workspaceRef,
		artifactRef: run.artifactRef,
		createdAt: toIso(run.createdAt) ?? new Date(0).toISOString(),
		completedAt: toIso(run.completedAt),
		eventPublishedAt: toIso(run.eventPublishedAt),
		lastReconciledAt: toIso(run.lastReconciledAt),
		error: run.error,
		result: run.result,
	}));
}

export function toDurableExternalEventSummary(
	events: ExternalEventLike[],
): DurableExternalEventSummary[] {
	return events.map((event) => ({
		id: event.id,
		nodeId: event.nodeId,
		eventName: event.eventName,
		eventType: event.eventType,
		approved: event.approved,
		reason: event.reason,
		respondedBy: event.respondedBy,
		requestedAt: toIso(event.requestedAt),
		respondedAt: toIso(event.respondedAt),
		expiresAt: toIso(event.expiresAt),
		createdAt: toIso(event.createdAt) ?? new Date(0).toISOString(),
		payload: event.payload,
	}));
}

export function toDurablePlanArtifactSummary(
	artifacts: PlanArtifactLike[],
): DurablePlanArtifactSummary[] {
	return artifacts.map((artifact) => ({
		id: artifact.id,
		nodeId: artifact.nodeId,
		status: artifact.status,
		artifactType: artifact.artifactType,
		artifactVersion: artifact.artifactVersion,
		goal: artifact.goal,
		workspaceRef: artifact.workspaceRef,
		clonePath: artifact.clonePath,
		createdAt: toIso(artifact.createdAt) ?? new Date(0).toISOString(),
		updatedAt: toIso(artifact.updatedAt) ?? new Date(0).toISOString(),
		metadata: artifact.metadata,
	}));
}

export function buildDurableTimeline(
	input: BuildTimelineInput,
): DurableTimelineEvent[] {
	const events: DurableTimelineEvent[] = [];

	for (const [index, historyEvent] of (
		input.orchestratorHistory ?? []
	).entries()) {
		const mapped = mapOrchestratorEvent(historyEvent, index);
		if (mapped) {
			events.push(mapped);
		}
	}

	for (const log of input.logs) {
		const ts = toIso(log.timestamp ?? log.startedAt);
		if (!ts) {
			continue;
		}
		events.push({
			id: `log-${log.id}`,
			ts,
			kind: kindForLogStatus(log.status),
			source: "execution_log",
			status: log.status,
			nodeId: log.nodeId,
			nodeName: log.nodeName,
			activityName: log.activityName,
			label: log.nodeName || log.nodeId,
			input: log.input,
			output: log.output,
			error: log.error,
			durationMs: log.executionMs ?? parseDurationMs(log.duration),
			refs: { logId: log.id },
		});
	}

	for (const event of input.externalEvents) {
		const ts = toIso(event.createdAt);
		if (!ts) {
			continue;
		}
		events.push({
			id: `ext-${event.id}`,
			ts,
			kind:
				event.eventType === "approval_request"
					? "approval_requested"
					: "approval_responded",
			source: "external_event",
			status: event.eventType,
			nodeId: event.nodeId,
			label: event.eventName,
			output: event.payload,
			refs: {
				eventId: event.id,
				approved: event.approved,
				respondedBy: event.respondedBy,
			},
		});
	}

	for (const artifact of input.planArtifacts) {
		const ts = toIso(artifact.updatedAt ?? artifact.createdAt);
		if (!ts) {
			continue;
		}
		events.push({
			id: `plan-${artifact.id}`,
			ts,
			kind:
				artifact.status === "draft"
					? "plan_artifact_created"
					: "plan_artifact_status_changed",
			source: "plan_artifact",
			status: artifact.status,
			nodeId: artifact.nodeId,
			label: artifact.goal,
			refs: {
				artifactId: artifact.id,
				artifactType: artifact.artifactType,
				artifactVersion: artifact.artifactVersion,
			},
		});
	}

	for (const run of input.agentRuns) {
		const createdAt = toIso(run.createdAt);
		if (createdAt) {
			events.push({
				id: `child-scheduled-${run.id}`,
				ts: createdAt,
				kind: "child_run_scheduled",
				source: "agent_run",
				status: run.status,
				nodeId: run.nodeId,
				label: `${run.mode} child run scheduled`,
				refs: {
					agentRunId: run.id,
					agentWorkflowId: run.agentWorkflowId,
					daprInstanceId: run.daprInstanceId,
				},
			});
		}

		const completedAt = toIso(run.completedAt);
		if (completedAt) {
			const failed = run.status === "failed";
			events.push({
				id: `child-finish-${run.id}`,
				ts: completedAt,
				kind: failed ? "child_run_failed" : "child_run_completed",
				source: "agent_run",
				status: run.status,
				nodeId: run.nodeId,
				label: `${run.mode} child run ${failed ? "failed" : "completed"}`,
				output: run.result,
				error: run.error,
				refs: {
					agentRunId: run.id,
					agentWorkflowId: run.agentWorkflowId,
					daprInstanceId: run.daprInstanceId,
				},
			});
		}
	}

	const startedAt = toIso(input.execution.startedAt);
	if (startedAt && !events.some((event) => event.kind === "workflow_started")) {
		events.push({
			id: `wf-start-${input.execution.id}`,
			ts: startedAt,
			kind: "workflow_started",
			source: "db_fallback",
			label: "Workflow started",
		});
	}

	const completedAt = toIso(input.execution.completedAt);
	if (
		completedAt &&
		!events.some(
			(event) =>
				event.kind === "workflow_completed" || event.kind === "workflow_failed",
		)
	) {
		events.push({
			id: `wf-end-${input.execution.id}`,
			ts: completedAt,
			kind: kindForRuntimeCompletion(input.execution.status),
			source: "db_fallback",
			status: input.execution.status,
			label:
				input.execution.status === "success"
					? "Workflow completed"
					: "Workflow failed",
			error: input.execution.error,
		});
	}

	return events.sort((a, b) => {
		const timeDiff = new Date(a.ts).getTime() - new Date(b.ts).getTime();
		if (timeDiff !== 0) {
			return timeDiff;
		}
		const sourceA = SOURCE_ORDER[a.source] ?? 999;
		const sourceB = SOURCE_ORDER[b.source] ?? 999;
		if (sourceA !== sourceB) {
			return sourceA - sourceB;
		}
		return a.id.localeCompare(b.id);
	});
}

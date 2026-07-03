import type {
	WorkflowDataService,
	WorkflowExecutionAgentEventRecord,
	WorkflowExecutionLogRecord,
	WorkflowExecutionRecord,
} from "$lib/server/application/ports";

export interface NormalizedWorkflowExecutionLog {
	stepName: string;
	label: string;
	actionType: string;
	status: "success" | "error" | "running" | "pending" | "unknown";
	input: unknown;
	output: unknown;
	error: string | null;
	durationMs: number | null;
}

export type WorkflowExecutionLogAgentEvent = {
	id: number;
	type: string;
	sourceEventId: string | null;
	workflowAgentRunId: string;
	daprInstanceId: string;
	sessionId: string;
	toolName: string | null;
	phase: string | null;
	data: Record<string, unknown>;
	timestamp: string;
};

export type WorkflowExecutionLogsInput = {
	executionId: string;
	userId?: string | null;
	projectId?: string | null;
};

export type WorkflowExecutionLogsBody = {
	logs: NormalizedWorkflowExecutionLog[];
	agentEvents: WorkflowExecutionLogAgentEvent[];
	traceId: string | null;
	traceIds: string[];
	executionStatus: string;
	input: unknown;
	output: unknown;
};

export type WorkflowExecutionLogsResult =
	| { status: "ok"; body: WorkflowExecutionLogsBody }
	| { status: "error"; httpStatus: number; message: string };

export type WorkflowExecutionTraceExtractor = (output: unknown) => string[];

export class ApplicationWorkflowExecutionLogsService {
	constructor(
		private readonly deps: {
			workflowData: Pick<
				WorkflowDataService,
				| "getExecutionById"
				| "getScopedExecutionById"
				| "listExecutionLogs"
				| "listExecutionAgentEvents"
			>;
			traceExtractor: WorkflowExecutionTraceExtractor;
		},
	) {}

	async getLogs(
		input: WorkflowExecutionLogsInput,
	): Promise<WorkflowExecutionLogsResult> {
		const execution = await this.loadExecution(input);
		if (!execution) {
			return {
				status: "error",
				httpStatus: 404,
				message: "Execution not found",
			};
		}

		const persistedLogs = await this.deps.workflowData.listExecutionLogs(
			input.executionId,
		);
		const logs =
			persistedLogs.length > 0
				? normalizePersistedLogs(persistedLogs)
				: normalizeOutputLogs(execution.output);
		const agentEvents = await this.deps.workflowData.listExecutionAgentEvents(
			input.executionId,
		);
		const execOutput =
			execution.output && typeof execution.output === "object"
				? (execution.output as Record<string, unknown>)
				: null;

		return {
			status: "ok",
			body: {
				logs: dedupeAndFilterLogs(logs),
				agentEvents: agentEvents.map(normalizeAgentEvent),
				traceId:
					typeof execOutput?.traceId === "string" ? execOutput.traceId : null,
				traceIds: this.deps.traceExtractor(execution.output),
				executionStatus: execution.status,
				input: execution.input,
				output: execution.output,
			},
		};
	}

	private loadExecution(input: WorkflowExecutionLogsInput) {
		if (input.userId) {
			return this.deps.workflowData.getScopedExecutionById({
				executionId: input.executionId,
				userId: input.userId,
				projectId: input.projectId ?? null,
			});
		}
		return this.deps.workflowData.getExecutionById(input.executionId);
	}
}

function normalizePersistedLogs(
	logs: WorkflowExecutionLogRecord[],
): NormalizedWorkflowExecutionLog[] {
	return logs.map((log) => ({
		stepName: log.nodeId,
		label: log.nodeName,
		actionType: log.activityName ?? log.nodeType,
		status: isNormalizedLogStatus(log.status) ? log.status : "unknown",
		input: log.input,
		output: log.output,
		error: log.error,
		durationMs: log.duration ? parseInt(log.duration, 10) : null,
	}));
}

function normalizeOutputLogs(output: WorkflowExecutionRecord["output"]) {
	const execOutput =
		output && typeof output === "object"
			? (output as Record<string, unknown>)
			: null;
	const stepOutputs =
		execOutput?.outputs && typeof execOutput.outputs === "object"
			? (execOutput.outputs as Record<string, unknown>)
			: null;
	if (!stepOutputs) return [];

	return Object.entries(stepOutputs).map(([name, val]) => {
		const v = val && typeof val === "object" ? (val as Record<string, unknown>) : {};
		const d =
			v.data && typeof v.data === "object"
				? (v.data as Record<string, unknown>)
				: undefined;
		return {
			stepName: name,
			label: (v.label as string) || name,
			actionType: (v.actionType as string) || "",
			status: (d?.success === false || d?.error
				? "error"
				: d?.success === true
					? "success"
					: "unknown") as NormalizedWorkflowExecutionLog["status"],
			input: d?.input ?? null,
			output: d?.output ?? d ?? null,
			error: (d?.error as string) ?? null,
			durationMs: (d?.duration_ms as number) ?? null,
		};
	});
}

function dedupeAndFilterLogs(
	logs: NormalizedWorkflowExecutionLog[],
): NormalizedWorkflowExecutionLog[] {
	const seen = new Set<string>();
	return logs.filter((log) => {
		if (seen.has(log.stepName)) return false;
		seen.add(log.stepName);
		return !["trigger", "state"].includes(log.stepName);
	});
}

function normalizeAgentEvent(
	event: WorkflowExecutionAgentEventRecord,
): WorkflowExecutionLogAgentEvent {
	const rawData =
		event.data && typeof event.data === "object"
			? (event.data as Record<string, unknown>)
			: {};
	const internalType = toInternalType(event.type, rawData);
	const data = toInternalData(internalType, rawData);
	return {
		id: event.id,
		type: internalType,
		sourceEventId: event.sourceEventId,
		workflowAgentRunId: event.sessionId,
		daprInstanceId: event.sessionId,
		sessionId: event.sessionId,
		toolName: pickString(data, "toolName", "tool_name", "name"),
		phase: pickString(data, "phase"),
		data,
		timestamp: event.createdAt?.toISOString() ?? "",
	};
}

function isNormalizedLogStatus(
	status: string,
): status is NormalizedWorkflowExecutionLog["status"] {
	return ["success", "error", "running", "pending"].includes(status);
}

function pickString(source: Record<string, unknown>, ...keys: string[]): string | null {
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return null;
}

const CMA_TO_INTERNAL: Record<string, string> = {
	"agent.message": "llm_complete",
	"agent.tool_use": "tool_call_start",
	"agent.tool_result": "tool_call_end",
};

function toInternalType(cmaType: string, data: Record<string, unknown>): string {
	const stashed = data["_internalType"];
	if (typeof stashed === "string" && stashed.trim()) return stashed;
	return CMA_TO_INTERNAL[cmaType] ?? cmaType;
}

function toInternalData(
	internalType: string,
	data: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...data };
	if (internalType === "tool_call_start") {
		if (!("toolName" in out) && typeof out.name === "string") out.toolName = out.name;
		if (!("args" in out) && out.input !== undefined) out.args = out.input;
	} else if (internalType === "tool_call_end" || internalType === "tool_call_error") {
		if (!("toolName" in out)) {
			const toolName = out.tool_name ?? out.toolName ?? out.name;
			if (typeof toolName === "string") out.toolName = toolName;
		}
	} else if (internalType === "llm_complete" && Array.isArray(out.content)) {
		out.content = out.content
			.map((block) => {
				if (block && typeof block === "object") {
					const text = (block as Record<string, unknown>).text;
					if (typeof text === "string") return text;
				}
				return "";
			})
			.join("");
	}
	return out;
}

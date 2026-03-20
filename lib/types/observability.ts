export type ObservabilityEntityType = "workflow";

export type ObservabilityEntityOption = {
	id: string;
	name: string;
	type: ObservabilityEntityType;
};

export type ObservabilityTraceStatus = "ok" | "error" | "unknown";

export type ObservabilityServiceRole =
	| "orchestrator"
	| "agent-runtime"
	| "builder-ui"
	| "function-router"
	| "system-function"
	| "service"
	| "unknown";

export type ObservabilitySpanCategory =
	| "workflow"
	| "child-workflow"
	| "activity"
	| "agent"
	| "tool"
	| "llm"
	| "http"
	| "runtime"
	| "unknown";

export type ObservabilityTraceRuntime =
	| "dapr-workflow"
	| "dapr-agent"
	| "app-trace"
	| "unknown";

export type ObservabilityTraceBreakdown = {
	workflowSpans: number;
	childWorkflowSpans: number;
	activitySpans: number;
	agentSpans: number;
	toolSpans: number;
	llmSpans: number;
	httpSpans: number;
	otherSpans: number;
};

export type ObservabilityTraceSummary = {
	traceId: string;
	name: string;
	startedAt: string;
	endedAt: string | null;
	durationMs: number;
	spanCount: number;
	serviceName: string | null;
	status: ObservabilityTraceStatus;
	workflowId: string | null;
	workflowName: string | null;
	executionId: string | null;
	daprInstanceId: string | null;
	phase: string | null;
	nodeId?: string | null;
	nodeName?: string | null;
	activityName?: string | null;
	agentRunId?: string | null;
	agentWorkflowId?: string | null;
	parentExecutionId?: string | null;
	correlationConfidence?: "execution" | "instance" | "workflow" | "unknown";
	runtime: ObservabilityTraceRuntime;
	rootSpanCategory: ObservabilitySpanCategory;
	serviceNames: string[];
	serviceRoles: ObservabilityServiceRole[];
	breakdown: ObservabilityTraceBreakdown;
};

export type ObservabilitySpan = {
	traceId: string;
	spanId: string;
	parentSpanId: string | null;
	name: string;
	serviceName: string | null;
	startedAt: string;
	endedAt: string | null;
	durationMs: number;
	statusCode: string | null;
	kind: string | null;
	attributes: Record<string, unknown>;
	category: ObservabilitySpanCategory;
	serviceRole: ObservabilityServiceRole;
};

export type ObservabilityTraceDetails = {
	trace: ObservabilityTraceSummary;
	spans: ObservabilitySpan[];
};

export type ObservabilityTraceFilters = {
	entityType?: ObservabilityEntityType;
	entityId?: string;
	from?: string;
	to?: string;
	cursor?: string;
	limit?: number;
	search?: string;
};

export type ObservabilityTraceListResponse = {
	traces: ObservabilityTraceSummary[];
	nextCursor: string | null;
};

export type ObservabilityTraceDetailsResponse = {
	trace: ObservabilityTraceDetails;
};

export type ObservabilityEntitiesResponse = {
	entities: ObservabilityEntityOption[];
};

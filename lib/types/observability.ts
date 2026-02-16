export type ObservabilityEntityType = "workflow";

export type ObservabilityEntityOption = {
	id: string;
	name: string;
	type: ObservabilityEntityType;
};

export type ObservabilityTraceStatus = "ok" | "error" | "unknown";

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

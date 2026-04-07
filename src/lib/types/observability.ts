export interface ObservabilitySpanRef {
	traceId: string;
	spanId: string;
	parentSpanId: string | null;
	serviceName: string;
	timestamp: string;
	sessionId: string;
	workflowExecutionId: string;
	agentRunId: string | null;
	statusCode: string;
}

export interface ObservabilityLlmMessage {
	role: string;
	content: string | null;
	name?: string;
	toolCallId?: string;
	toolCalls?: Array<{
		id: string;
		type: string;
		function?: {
			name?: string;
			arguments?: string;
		};
	}>;
	timestamp?: string;
}

export interface ObservabilityLlmSpan extends ObservabilitySpanRef {
	modelName: string | null;
	provider: string | null;
	inputMessages: ObservabilityLlmMessage[];
	outputMessages: ObservabilityLlmMessage[];
	invocationParameters: Record<string, unknown> | null;
	finishReason: string | null;
	promptTokens: number | null;
	completionTokens: number | null;
	totalTokens: number | null;
	inputMessagesTruncated: boolean;
	outputMessagesTruncated: boolean;
	invocationParametersTruncated: boolean;
}

export interface ObservabilityToolSpan extends ObservabilitySpanRef {
	toolName: string;
	toolArguments: unknown;
	toolResult: unknown;
	toolArgumentsTruncated: boolean;
	toolResultTruncated: boolean;
}

export interface ObservabilityLogEntry {
	timestamp: string;
	traceId: string;
	spanId: string;
	serviceName: string;
	severityText: string;
	body: string;
	resourceAttributes: Record<string, unknown>;
	logAttributes: Record<string, unknown>;
}

export interface ObservabilityTraceSpan {
	traceId: string;
	spanId: string;
	parentSpanId: string | null;
	operationName: string;
	serviceName: string;
	startTime: string;
	duration: number;
	status: 'ok' | 'error';
	statusCode?: string;
	statusMessage?: string;
	spanKind?: string;
	attributes?: Record<string, unknown>;
	resourceAttributes?: Record<string, unknown>;
	depth: number;
}

export interface ObservabilityWorkflowStep {
	id: string;
	stepName: string;
	label: string;
	actionType: string;
	status: 'success' | 'error' | 'running' | 'pending' | 'unknown';
	input: unknown;
	output: unknown;
	error: string | null;
	durationMs: number | null;
	startedAt: string | null;
	completedAt: string | null;
	routedTo?: string | null;
}

export type ObservabilityInvestigationEventType =
	| 'workflow_step'
	| 'trace_span'
	| 'llm_turn'
	| 'tool_call'
	| 'log_entry'
	| 'issue_marker';

export type ObservabilityInvestigationSeverity =
	| 'info'
	| 'success'
	| 'warning'
	| 'error';

export interface ObservabilityIssueMarker {
	id: string;
	label: string;
	severity: ObservabilityInvestigationSeverity;
	timestamp: string;
	traceId?: string;
	spanId?: string;
	workflowStepName?: string;
	serviceName?: string;
}

export interface ObservabilityInvestigationEvent {
	id: string;
	type: ObservabilityInvestigationEventType;
	timestamp: string;
	endTimestamp?: string | null;
	title: string;
	subtitle?: string | null;
	preview?: string | null;
	serviceName?: string | null;
	severity: ObservabilityInvestigationSeverity;
	traceId?: string | null;
	spanId?: string | null;
	workflowStepName?: string | null;
	durationMs?: number | null;
	tags?: string[];
	metricLabel?: string | null;
	metricValue?: string | null;
	data?: Record<string, unknown> | null;
}

export interface ObservabilitySessionSummary {
	scope: 'session' | 'trace';
	sessionId: string | null;
	traceIds: string[];
	traceCount: number;
	spanCount: number;
	llmTurnCount: number;
	toolCallCount: number;
	logCount: number;
	workflowStepCount: number;
	serviceCount: number;
	errorCount: number;
	totalDurationMs: number;
	totalTokens: number;
	startedAt: string | null;
	completedAt: string | null;
	status: string | null;
	slowestSpanId: string | null;
	firstFailureEventId: string | null;
	services: string[];
}

export interface ObservabilityInvestigationPayload {
	summary: ObservabilitySessionSummary;
	traceSpans: ObservabilityTraceSpan[];
	logs: ObservabilityLogEntry[];
	llmSpans: ObservabilityLlmSpan[];
	toolSpans: ObservabilityToolSpan[];
	workflowSteps: ObservabilityWorkflowStep[];
	events: ObservabilityInvestigationEvent[];
	issues: ObservabilityIssueMarker[];
}

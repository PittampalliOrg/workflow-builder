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
	cacheReadInputTokens: number | null;
	cacheCreationInputTokens: number | null;
	reasoningTokens: number | null;
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

export type ObservabilityAgentDecisionType =
	| 'tool_call'
	| 'assistant_message'
	| 'wait_or_approval'
	| 'stop'
	| 'error';

export interface ObservabilityAgentDecisionToolCall {
	name: string;
	arguments: string | null;
	id: string | null;
}

export interface ObservabilityAgentDecisionToolResult {
	toolName: string;
	statusCode: string;
	result: unknown;
	timestamp: string;
	spanId: string;
	traceId: string;
}

export interface ObservabilityAgentDecisionEvidence {
	traceId: string;
	spanId: string;
	logIds: string[];
	toolSpanIds: string[];
}

export interface ObservabilityAgentDecisionTurn {
	id: string;
	agentRunId: string | null;
	turnIndex: number;
	traceId: string;
	spanId: string;
	serviceName: string;
	startedAt: string;
	durationMs: number | null;
	decisionType: ObservabilityAgentDecisionType;
	decisionLabel: string;
	modelName: string | null;
	provider: string | null;
	inputSummary: string | null;
	outputSummary: string | null;
	toolCalls: ObservabilityAgentDecisionToolCall[];
	toolResults: ObservabilityAgentDecisionToolResult[];
	finishReason: string | null;
	stopReason: string | null;
	promptTokens: number | null;
	completionTokens: number | null;
	totalTokens: number | null;
	cacheReadInputTokens: number | null;
	cacheCreationInputTokens: number | null;
	reasoningTokens: number | null;
	status: 'ok' | 'error';
	evidence: ObservabilityAgentDecisionEvidence;
}

export interface ObservabilityAgentDecisionSummary {
	totalTurns: number;
	toolCallTurns: number;
	assistantMessageTurns: number;
	waitOrApprovalTurns: number;
	stopTurns: number;
	errorTurns: number;
	totalToolCalls: number;
	totalDurationMs: number;
	totalTokens: number;
	averageTurnLatencyMs: number;
	stopReason: string | null;
}

export interface ObservabilityAgentDecisionDiagramNode {
	id: string;
	label: string;
	type: 'state' | 'decision';
	count: number;
	totalDurationMs: number;
	isTerminal?: boolean;
}

export interface ObservabilityAgentDecisionDiagramEdge {
	id: string;
	from: string;
	to: string;
	count: number;
	totalDurationMs: number;
	turnIds: string[];
}

export interface ObservabilityAgentDecisionDiagram {
	nodes: ObservabilityAgentDecisionDiagramNode[];
	edges: ObservabilityAgentDecisionDiagramEdge[];
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
	/** True when the initial payload contains only the attributes needed for the timeline/graph. */
	attributesTruncated?: boolean;
	hasInput?: boolean;
	hasOutput?: boolean;
	inputSize?: number;
	outputSize?: number;
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

export type ObservabilityWorkflowTimelineKind =
	| 'workflow_node'
	| 'dapr_activity'
	| 'child_workflow'
	| 'system';

export type ObservabilityWorkflowCorrelationSource =
	| 'workflow_node'
	| 'workflow_logs'
	| 'dapr_task'
	| 'time_overlap';

export interface ObservabilityWorkflowTimelineItem {
	id: string;
	sequence: number | null;
	kind: ObservabilityWorkflowTimelineKind;
	title: string;
	subtitle: string | null;
	status: 'success' | 'error' | 'running' | 'pending' | 'unknown';
	startedAt: string | null;
	completedAt: string | null;
	durationMs: number | null;
	nodeId: string | null;
	nodeName: string | null;
	actionType: string | null;
	traceId: string | null;
	spanId: string | null;
	relatedSpanIds: string[];
	correlationId: string | null;
	daprTaskIds: string[];
	correlationSources: ObservabilityWorkflowCorrelationSource[];
	durableTaskId: string | null;
	durableTaskName: string | null;
	serviceName: string | null;
	inputSpanId: string | null;
	outputSpanId: string | null;
	hasInput: boolean;
	hasOutput: boolean;
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
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	reasoningTokens: number;
	startedAt: string | null;
	completedAt: string | null;
	status: string | null;
	slowestSpanId: string | null;
	firstFailureEventId: string | null;
	services: string[];
}

// --- Goal-evaluator flow (Postgres-derived: thread_goals + session_events) ---
// The evaluator emits no OTEL spans, so this layer is assembled separately and
// rendered as the "Goal" view to make the agent-work → submit → evaluate →
// verdict → loop → complete sequence legible.

export type GoalFlowStatus = 'active' | 'paused' | 'budget_limited' | 'complete';
export type GoalFlowVerdict = 'pass' | 'reject' | 'none';

/** One deterministic evidence check (REJECT carries these; PASS persists none). */
export interface GoalFlowCheck {
	command: string;
	exitCode: number;
	ok: boolean;
	output: string;
}

export interface GoalFlowVerdictDetail {
	kind: GoalFlowVerdict;
	source: 'goal_completed' | 'goal_rejected' | 'update_goal' | 'idle_backstop' | null;
	at: string | null;
	feedback: string | null;
	/** REJECT: per-command results. PASS: empty (not persisted). */
	checks: GoalFlowCheck[];
	failingCount: number;
	/** PASS: number of evidence commands verified; else null. */
	verifiedCount: number | null;
}

export interface GoalFlowAttempt {
	id: string;
	iteration: number;
	startedAt: string | null;
	endedAt: string | null;
	work: {
		turnCount: number;
		toolNames: string[];
		toolCallCount: number;
		tokenDelta: number | null;
	};
	submission: {
		kind: 'update_goal' | 'idle_backstop' | 'none';
		at: string | null;
	};
	verdict: GoalFlowVerdictDetail;
	relatedTurnIds: string[];
	relatedSpanIds: string[];
}

export interface GoalFlowOutcome {
	verdict: GoalFlowVerdict;
	label: string;
	evidenceVerified: boolean;
	attemptCount: number;
}

export interface GoalFlow {
	sessionId: string;
	goalId: string;
	objective: string;
	acceptanceCriteria: string[];
	evidenceCommands: string[];
	status: GoalFlowStatus;
	iterations: number;
	maxIterations: number;
	tokensUsed: number;
	tokenBudget: number | null;
	stopReason: string | null;
	completionSource: string | null;
	startedAt: string | null;
	completedAt: string | null;
	attempts: GoalFlowAttempt[];
	outcome: GoalFlowOutcome;
}

export interface ObservabilityInvestigationPayload {
	summary: ObservabilitySessionSummary;
	goalFlow?: GoalFlow | null;
	traceSpans: ObservabilityTraceSpan[];
	logs: ObservabilityLogEntry[];
	llmSpans: ObservabilityLlmSpan[];
	toolSpans: ObservabilityToolSpan[];
	agentDecisionSummary: ObservabilityAgentDecisionSummary | null;
	agentDecisions: ObservabilityAgentDecisionTurn[];
	agentDecisionDiagram: ObservabilityAgentDecisionDiagram | null;
	workflowSteps: ObservabilityWorkflowStep[];
	workflowTimeline: ObservabilityWorkflowTimelineItem[];
	events: ObservabilityInvestigationEvent[];
	issues: ObservabilityIssueMarker[];
}

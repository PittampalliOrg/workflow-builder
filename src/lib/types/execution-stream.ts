export interface ExecutionTimelineEvent {
	id: number;
	type: string;
	data: Record<string, unknown>;
	timestamp: string;
	workflowAgentRunId?: string | null;
	daprInstanceId?: string | null;
	phase?: string | null;
	toolName?: string | null;
}

export interface ExecutionAgentRun {
	id: string;
	workflowExecutionId: string;
	workflowId: string;
	nodeId: string;
	mode: 'run' | 'plan' | 'execute_plan';
	status: 'scheduled' | 'running' | 'completed' | 'failed' | 'event_published';
	agentWorkflowId: string;
	daprInstanceId: string;
	parentExecutionId: string;
	workspaceRef: string | null;
	artifactRef: string | null;
	result: Record<string, unknown> | null;
	error: string | null;
	createdAt: string | null;
	updatedAt: string | null;
	completedAt: string | null;
}

export interface ExecutionStepLog {
	logId?: string;
	stepName: string;
	label: string;
	displayLabel?: string;
	actionType: string;
	status: 'success' | 'error' | 'running' | 'pending' | 'unknown';
	input: unknown;
	output: unknown;
	error: string | null;
	durationMs: number | null;
	startedAt: string | null;
	completedAt: string | null;
	attempt?: number;
	attemptsTotal?: number;
}

export interface ExecutionReadModel {
	executionId: string;
	workflowId: string;
	instanceId: string | null;
	status: 'pending' | 'running' | 'success' | 'error' | 'cancelled';
	runtimeStatus: string | null;
	phase: string | null;
	progress: number | null;
	currentNodeId: string | null;
	currentNodeName: string | null;
	traceId: string | null;
	traceIds: string[];
	sessionId: string | null;
	input: Record<string, unknown> | null;
	output: unknown;
	summaryOutput: Record<string, unknown> | null;
	error: string | null;
	startedAt: string | null;
	completedAt: string | null;
	nodeStatuses: Record<string, string>;
	steps: ExecutionStepLog[];
	browserArtifacts: Array<Record<string, unknown>>;
	agentRuns: ExecutionAgentRun[];
	agentEvents: ExecutionTimelineEvent[];
	lastAgentEventId: number;
}

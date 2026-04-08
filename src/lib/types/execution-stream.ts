export interface ExecutionTimelineEvent {
	id: number;
	type: string;
	data: Record<string, unknown>;
	timestamp: string;
}

export interface ExecutionStepLog {
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
	agentEvents: ExecutionTimelineEvent[];
	lastAgentEventId: number;
}

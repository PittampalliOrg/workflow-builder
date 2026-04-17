export interface ExecutionTimelineEvent {
	id: number;
	type: string;
	data: Record<string, unknown>;
	timestamp: string;
	workflowAgentRunId?: string | null;
	daprInstanceId?: string | null;
	phase?: string | null;
	toolName?: string | null;
	executionId?: string | null;
	runId?: string | null;
	callId?: string | null;
	source?: string | null;
	sourceEventId?: string | null;
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

export interface ExecutionWorkspaceSession {
	workspaceRef: string;
	// UI-provisioned sandboxes have no workflow execution; null for those.
	workflowExecutionId: string | null;
	durableInstanceId: string | null;
	name: string;
	rootPath: string;
	clonePath: string | null;
	backend: 'openshell';
	enabledTools: string[];
	requireReadBeforeWrite: boolean;
	commandTimeoutMs: number;
	status: 'active' | 'cleaned' | 'error';
	lastError: string | null;
	createdAt: string | null;
	updatedAt: string | null;
	lastAccessedAt: string | null;
	cleanedAt: string | null;
	sandboxState: Record<string, unknown> | null;
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
	workspaces: ExecutionWorkspaceSession[];
	agentEvents: ExecutionTimelineEvent[];
	lastAgentEventId: number;
}

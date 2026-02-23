export type DurableTimelineEventKind =
	| "workflow_started"
	| "node_scheduled"
	| "node_started"
	| "node_completed"
	| "node_failed"
	| "approval_requested"
	| "approval_responded"
	| "plan_artifact_created"
	| "plan_artifact_status_changed"
	| "child_run_scheduled"
	| "child_run_completed"
	| "child_run_failed"
	| "workflow_completed"
	| "workflow_failed";

export type DurableTimelineEventSource =
	| "orchestrator_history"
	| "execution_log"
	| "external_event"
	| "plan_artifact"
	| "agent_run"
	| "db_fallback";

export type DurableTimelineEventStatus = string | null;

export type DurableTimelineEvent = {
	id: string;
	ts: string;
	kind: DurableTimelineEventKind;
	source: DurableTimelineEventSource;
	status?: DurableTimelineEventStatus;
	nodeId?: string | null;
	nodeName?: string | null;
	activityName?: string | null;
	label: string;
	input?: unknown;
	output?: unknown;
	error?: string | null;
	durationMs?: number | null;
	refs?: Record<string, string | number | boolean | null | undefined>;
};

export type DurableAgentRunSummary = {
	id: string;
	nodeId: string;
	mode: string;
	status: string;
	agentWorkflowId: string;
	daprInstanceId: string;
	parentExecutionId: string;
	workspaceRef: string | null;
	artifactRef: string | null;
	createdAt: string;
	completedAt: string | null;
	eventPublishedAt: string | null;
	lastReconciledAt: string | null;
	error: string | null;
	result: unknown;
};

export type DurableExternalEventSummary = {
	id: string;
	nodeId: string;
	eventName: string;
	eventType: string;
	approved: boolean | null;
	reason: string | null;
	respondedBy: string | null;
	requestedAt: string | null;
	respondedAt: string | null;
	expiresAt: string | null;
	createdAt: string;
	payload: unknown;
};

export type DurablePlanArtifactSummary = {
	id: string;
	nodeId: string;
	status: string;
	artifactType: string;
	artifactVersion: number;
	goal: string;
	workspaceRef: string | null;
	clonePath: string | null;
	createdAt: string;
	updatedAt: string;
	metadata: Record<string, unknown> | null;
};

export type DurableRuntimeSnapshot = {
	runtimeStatus: string;
	phase: string | null;
	progress: number | null;
	message: string | null;
	currentNodeId: string | null;
	currentNodeName: string | null;
	approvalEventName: string | null;
	traceId: string | null;
	startedAt: string | null;
	completedAt: string | null;
	outputs?: Record<string, unknown>;
	error?: string | null;
};

export type DurableExecutionConsistency = {
	statusDiverged: boolean;
	dbStatus: string;
	runtimeStatus: string | null;
	dbPhase: string | null;
	runtimePhase: string | null;
	notes: string[];
};

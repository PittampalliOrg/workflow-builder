export type SessionStatus =
	| "rescheduling"
	| "running"
	| "idle"
	| "terminated";

export type SessionStopReasonType =
	| "end_turn"
	| "requires_action"
	| "retries_exhausted";

export type SessionStopReason = {
	type: SessionStopReasonType;
	event_ids?: string[];
};

export type SessionUsage = {
	input_tokens?: number;
	output_tokens?: number;
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
};

export type SessionSummary = {
	id: string;
	title: string | null;
	status: SessionStatus;
	stopReason: SessionStopReason | null;
	agentId: string;
	agentVersion: number | null;
	environmentId: string | null;
	environmentVersion: number | null;
	vaultIds: string[];
	usage: SessionUsage;
	errorMessage: string | null;
	workflowExecutionId: string | null;
	/** Populated for workflow-driven sessions via join in listSessions. */
	workflowId: string | null;
	workflowName: string | null;
	/** Joined from the agents table so the UI can render a name for
	 * workflow-ephemeral agents too — those are filtered out of the
	 * /api/agents catalog by design but still need a label in sessions. */
	agentName: string | null;
	agentSlug: string | null;
	agentAvatar: string | null;
	agentEphemeral: boolean;
	createdAt: string;
	updatedAt: string;
	completedAt: string | null;
	archivedAt: string | null;
};

export type SessionDetail = SessionSummary & {
	daprInstanceId: string | null;
	natsSubject: string | null;
	parentExecutionId: string | null;
	sandboxName: string | null;
	workspaceSandboxName: string | null;
};

export type SessionResourceType = "file" | "github_repository";

export type SessionResource = {
	id: string;
	sessionId: string;
	type: SessionResourceType;
	fileId: string | null;
	mountPath: string | null;
	repoUrl: string | null;
	checkoutRef: string | null;
	authTokenCredentialId: string | null;
	mountedAt: string | null;
	removedAt: string | null;
};

/**
 * Events are the bidirectional wire between clients and the agent. Mirrors
 * the CMA shape exactly. User-side events queue into the Dapr workflow as
 * external events; agent-side events flow out via NATS → SSE.
 */
export type UserMessageEvent = {
	type: "user.message";
	content: Array<{ type: "text"; text: string }>;
};

export type UserInterruptEvent = {
	type: "user.interrupt";
};

export type UserToolConfirmationEvent = {
	type: "user.tool_confirmation";
	tool_use_id: string;
	result: "allow" | "deny";
	deny_message?: string;
};

export type UserCustomToolResultEvent = {
	type: "user.custom_tool_result";
	tool_use_id: string;
	content: Array<{ type: "text"; text: string }>;
	is_error?: boolean;
};

export type UserEvent =
	| UserMessageEvent
	| UserInterruptEvent
	| UserToolConfirmationEvent
	| UserCustomToolResultEvent;

/**
 * Agent-side event envelope. The `data` shape depends on `type` — kept loose
 * here because the dapr-agent-py event_publisher writes a wide range of
 * payloads and the UI renders them by dispatching on `type`.
 */
export type SessionEventEnvelope = {
	id: string;
	sessionId: string;
	sequence: number;
	type: string;
	data: Record<string, unknown>;
	processedAt: string | null;
	sourceEventId: string | null;
	createdAt: string;
};

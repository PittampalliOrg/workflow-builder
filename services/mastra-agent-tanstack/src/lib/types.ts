/**
 * Types for Mastra Agent MCP server
 */

export type AgentEventType =
	| "agent_started"
	| "agent_completed"
	| "planning_started"
	| "planning_completed"
	| "tool_call"
	| "tool_result"
	| "llm_start"
	| "llm_end"
	| "dapr_event";

export type AgentEvent = {
	id: string;
	type: AgentEventType;
	timestamp: string;
	runId: string | null;
	callId?: string;
	data: Record<string, any>;
};

export type AgentStatus = "idle" | "running" | "error";

export type AgentState = {
	status: AgentStatus;
	currentActivity: string | null;
	runId: string | null;
	startedAt: string | null;
	toolNames: string[];
	totalRuns: number;
	totalTokens: number;
	lastError: string | null;
};

export type WorkflowContext = {
	workflowId: string | null;
	instanceId: string | null;
	status: string | null;
	traceId: string | null;
	nodeId: string | null;
	stepIndex: number | null;
	receivedEvents: number;
};

export type LogEntry = {
	id: string;
	level: "log" | "warn" | "error" | "info";
	timestamp: string;
	message: string;
};

export type DaprEvent = {
	id: string;
	source: string;
	type: string;
	specversion: string;
	datacontenttype: string;
	data: Record<string, any>;
};

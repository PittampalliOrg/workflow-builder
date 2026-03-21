/**
 * Agent Stream Events — Shared event types for real-time agent streaming.
 *
 * Normalized schema inspired by AG-UI protocol. Used by both the BFF proxy
 * and the frontend useAgentStream hook.
 */

export type AgentStreamEventType =
	| "run_started"
	| "turn_started"
	| "llm_start"
	| "llm_token"
	| "llm_complete"
	| "tool_call_start"
	| "tool_call_end"
	| "tool_call_error"
	| "sandbox_output"
	| "state_snapshot"
	| "run_complete"
	| "run_error"
	// Raw event types from Python agent runtime (pre-normalization)
	| "tool_start"
	| "tool_complete"
	| "tool_error"
	| "model_start"
	| "model_complete";

export type AgentStreamEvent = {
	/** Unique event ID (for Last-Event-ID reconnection) */
	id: string;
	/** ISO timestamp */
	ts: string;
	/** Event type */
	type: AgentStreamEventType;
	/** Agent turn number (1-based) */
	turn?: number;
	/** Associated tool name */
	toolName?: string;
	/** Tool call arguments (JSON string or object) */
	toolArgs?: unknown;
	/** Tool call result (truncated if large) */
	toolResult?: unknown;
	/** Tool/sandbox exit code */
	exitCode?: number;
	/** Duration in milliseconds */
	durationMs?: number;
	/** Tool call status */
	status?: string;
	/** LLM token delta */
	token?: string;
	/** LLM full text (on llm_complete) */
	text?: string;
	/** Sandbox command */
	command?: string;
	/** Sandbox/tool output */
	output?: string;
	/** Current agent phase */
	phase?: string;
	/** Error message */
	error?: string;
	/** Finish reason */
	finishReason?: string;
	/** Extra metadata */
	meta?: Record<string, unknown>;
};

export type AgentToolCallDetail = {
	toolName: string;
	toolArgs: unknown;
	toolResult: unknown;
	durationMs: number | null;
	turn: number;
	status: "running" | "completed" | "error";
};

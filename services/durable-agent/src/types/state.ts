/**
 * Durable state model — mirrors Python dapr_agents/agents/schemas.py.
 *
 * These types define the durable state model for the agent workflow,
 * stored in Dapr state store (Redis).
 */

import type { ToolCall, ToolExecutionRecord } from "./tool.js";
import type { WorkflowStatus } from "./workflow-status.js";

/** A single message in the workflow conversation history. */
export interface AgentWorkflowMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string | null;
  /** Agent name (for multi-agent messages). */
  name?: string;
  /** Present on assistant messages that request tool calls. */
  tool_calls?: ToolCall[];
  /** Present on tool-result messages — ties back to the originating tool call. */
  tool_call_id?: string;
  timestamp: string; // ISO-8601
}

/** One workflow instance entry — mirrors AgentWorkflowEntry in schemas.py. */
export interface AgentWorkflowEntry {
  input_value: string;
  output: string | null;
  start_time: string;
  end_time: string | null;
  messages: AgentWorkflowMessage[];
  system_messages: AgentWorkflowMessage[];
  last_message: AgentWorkflowMessage | null;
  tool_history: ToolExecutionRecord[];
  source: string | null;
  workflow_instance_id: string | null;
  triggering_workflow_instance_id: string | null;
  workflow_name: string | null;
  session_id: string | null;
  trace_context: Record<string, unknown> | null;
  status: WorkflowStatus;
}

/** Top-level durable state — mirrors AgentWorkflowState in schemas.py. */
export interface AgentWorkflowState {
  instances: Record<string, AgentWorkflowEntry>;
}

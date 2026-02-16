/**
 * Tool call and execution record types.
 * Mirrors Python dapr_agents/types/tools.py.
 */

/** OpenAI-format tool call structure. */
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON-encoded
  };
}

/** Record of a tool execution for audit/history. */
export interface ToolExecutionRecord {
  id: string;
  timestamp: string; // ISO-8601
  tool_call_id: string;
  tool_name: string;
  tool_args: Record<string, unknown>;
  execution_result: string;
}

/**
 * Interface for tools that can be registered with DurableAgent.
 *
 * Compatible with Mastra createTool() objects and any tool that
 * exposes description, inputSchema, and execute().
 */
export interface DurableAgentTool {
  description?: string;
  inputSchema?: unknown;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

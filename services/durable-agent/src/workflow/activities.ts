/**
 * Dapr Workflow activities — all non-deterministic I/O.
 *
 * Activities are bound to the DurableAgent instance via closures in the
 * constructor, replacing the fragile `initActivities()` pattern.
 *
 * Mirrors Python durable.py:1171-1685.
 */

import type { WorkflowActivityContext } from "@dapr/dapr";
import { randomUUID } from "node:crypto";
import type { LanguageModel } from "ai";

import type {
  AgentWorkflowMessage,
  AgentWorkflowState,
  ToolCall,
  ToolExecutionRecord,
  DurableAgentTool,
} from "../types/index.js";
import type { DaprAgentState } from "../state/dapr-state.js";
import type { MemoryProvider } from "../memory/memory-base.js";
import { callLlmAdapter, type LlmCallResult } from "../llm/ai-sdk-adapter.js";

// --------------------------------------------------------------------------
// Payload types for activities
// --------------------------------------------------------------------------

export interface RecordInitialEntryPayload {
  instanceId: string;
  inputValue: string;
  source?: string;
  triggeringWorkflowInstanceId?: string;
  startTime?: string;
  traceContext?: Record<string, unknown>;
}

export interface CallLlmPayload {
  instanceId: string;
  task?: string;
}

export interface RunToolPayload {
  toolCall: ToolCall;
  instanceId: string;
  order: number;
}

export interface SaveToolResultsPayload {
  toolResults: Array<{
    role: string;
    content: string;
    tool_call_id: string;
    name: string;
  }>;
  instanceId: string;
}

export interface BroadcastPayload {
  message: Record<string, unknown>;
}

export interface SendResponseBackPayload {
  response: Record<string, unknown>;
  targetAgent: string;
  targetInstanceId: string;
}

export interface FinalizeWorkflowPayload {
  instanceId: string;
  finalOutput?: string;
  endTime?: string;
  triggeringWorkflowInstanceId?: string;
}

export interface GetAvailableAgentsPayload {
  // Empty — uses agent's registry
}

// --------------------------------------------------------------------------
// Activity factory functions
// --------------------------------------------------------------------------

/**
 * Create the recordInitialEntry activity bound to the agent.
 * Mirrors Python record_initial_entry at durable.py:1171-1222.
 */
export function createRecordInitialEntry(stateManager: DaprAgentState) {
  return async function recordInitialEntry(
    _ctx: WorkflowActivityContext,
    payload: RecordInitialEntryPayload,
  ): Promise<void> {
    const state = await stateManager.ensureInstance(
      payload.instanceId,
      payload.inputValue,
      payload.triggeringWorkflowInstanceId,
    );
    const entry = state.instances[payload.instanceId];
    if (!entry) return;

    entry.source = payload.source ?? "direct";
    if (payload.startTime) entry.start_time = payload.startTime;
    if (payload.triggeringWorkflowInstanceId) {
      entry.triggering_workflow_instance_id =
        payload.triggeringWorkflowInstanceId;
    }
    if (payload.traceContext) {
      entry.trace_context = payload.traceContext;
    }
    entry.status = "running";
    await stateManager.saveState(state);

    console.log(
      `[recordInitialEntry] instance=${payload.instanceId} input="${payload.inputValue}"`,
    );
  };
}

/**
 * Create the callLlm activity bound to the agent.
 * Mirrors Python call_llm at durable.py:1224-1325.
 */
export function createCallLlm(
  stateManager: DaprAgentState,
  model: LanguageModel,
  systemPrompt: string,
  tools: Record<string, DurableAgentTool>,
  memory: MemoryProvider,
) {
  return async function callLlm(
    _ctx: WorkflowActivityContext,
    payload: CallLlmPayload,
  ): Promise<LlmCallResult> {
    const state = await stateManager.loadState();
    const entry = state.instances[payload.instanceId];

    // On the first turn, prepend the user's task as a user message
    if (payload.task) {
      const userMsg: AgentWorkflowMessage = {
        id: randomUUID(),
        role: "user",
        content: payload.task,
        timestamp: new Date().toISOString(),
      };
      entry.messages.push(userMsg);
      entry.last_message = userMsg;

      // Also persist to memory
      memory.addMessage({
        role: "user",
        content: payload.task,
      });
    }

    // Call LLM with tool declarations (no auto-execute)
    const result = await callLlmAdapter(
      model,
      systemPrompt,
      entry.messages,
      tools,
    );

    // Build and persist assistant message
    const assistantMsg: AgentWorkflowMessage = {
      id: randomUUID(),
      role: "assistant",
      content: result.content,
      tool_calls: result.tool_calls,
      timestamp: new Date().toISOString(),
    };
    entry.messages.push(assistantMsg);
    entry.last_message = assistantMsg;
    await stateManager.saveState(state);

    // Also persist to memory
    memory.addMessage({
      role: "assistant",
      content: result.content ?? "",
    });

    console.log(
      `[callLlm] instance=${payload.instanceId} text=${(result.content ?? "").slice(0, 80)} toolCalls=${result.tool_calls?.length ?? 0}`,
    );

    return result;
  };
}

/**
 * Create the runTool activity bound to the agent.
 * Mirrors Python run_tool at durable.py:1327-1369.
 */
export function createRunTool(
  tools: Record<string, DurableAgentTool>,
) {
  return async function runTool(
    _ctx: WorkflowActivityContext,
    payload: RunToolPayload,
  ): Promise<{
    role: string;
    content: string;
    tool_call_id: string;
    name: string;
  }> {
    const { toolCall } = payload;
    const fnName = toolCall.function.name;
    const tool = tools[fnName];

    if (!tool) {
      const errMsg = `Unknown tool: ${fnName}`;
      console.error(`[runTool] ${errMsg}`);
      return {
        role: "tool",
        content: JSON.stringify({ error: errMsg }),
        tool_call_id: toolCall.id,
        name: fnName,
      };
    }

    const args = JSON.parse(toolCall.function.arguments);
    let result: unknown;
    try {
      result = await tool.execute(args);
    } catch (err) {
      result = { error: String(err) };
    }

    console.log(
      `[runTool] tool=${fnName} call_id=${toolCall.id} result=${JSON.stringify(result).slice(0, 120)}`,
    );

    return {
      role: "tool",
      content: JSON.stringify(result),
      tool_call_id: toolCall.id,
      name: fnName,
    };
  };
}

/**
 * Create the saveToolResults activity bound to the agent.
 * Mirrors Python save_tool_results at durable.py:1371-1424.
 */
export function createSaveToolResults(
  stateManager: DaprAgentState,
  memory: MemoryProvider,
) {
  return async function saveToolResults(
    _ctx: WorkflowActivityContext,
    payload: SaveToolResultsPayload,
  ): Promise<void> {
    const state = await stateManager.loadState();
    const entry = state.instances[payload.instanceId];

    // Deduplicate by tool_call_id to guard against replays
    const existingIds = new Set(
      entry.messages
        .filter((m) => m.role === "tool" && m.tool_call_id)
        .map((m) => m.tool_call_id),
    );

    for (const tr of payload.toolResults) {
      if (existingIds.has(tr.tool_call_id)) {
        console.log(
          `[saveToolResults] skipping duplicate tool_call_id=${tr.tool_call_id}`,
        );
        continue;
      }

      const msg: AgentWorkflowMessage = {
        id: randomUUID(),
        role: "tool",
        content: tr.content,
        tool_call_id: tr.tool_call_id,
        name: tr.name,
        timestamp: new Date().toISOString(),
      };
      entry.messages.push(msg);
      entry.last_message = msg;

      // Record in tool_history for audit
      const record: ToolExecutionRecord = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        tool_call_id: tr.tool_call_id,
        tool_name: tr.name,
        tool_args: {},
        execution_result: tr.content,
      };
      entry.tool_history.push(record);

      // Persist to memory
      memory.addMessage({
        role: "tool",
        content: tr.content,
        name: tr.name,
        tool_call_id: tr.tool_call_id,
      });
    }

    await stateManager.saveState(state);
    console.log(
      `[saveToolResults] instance=${payload.instanceId} saved ${payload.toolResults.length} result(s)`,
    );
  };
}

/**
 * Create the finalizeWorkflow activity bound to the agent.
 * Mirrors Python finalize_workflow at durable.py:1505-1538.
 */
export function createFinalizeWorkflow(stateManager: DaprAgentState) {
  return async function finalizeWorkflow(
    _ctx: WorkflowActivityContext,
    payload: FinalizeWorkflowPayload,
  ): Promise<void> {
    const state = await stateManager.loadState();
    const entry = state.instances[payload.instanceId];
    if (!entry) return;

    entry.status = payload.finalOutput ? "completed" : "failed";
    entry.output = payload.finalOutput ?? null;
    entry.end_time = payload.endTime ?? new Date().toISOString();
    if (payload.triggeringWorkflowInstanceId) {
      entry.triggering_workflow_instance_id =
        payload.triggeringWorkflowInstanceId;
    }
    await stateManager.saveState(state);

    console.log(
      `[finalizeWorkflow] instance=${payload.instanceId} status=${entry.status}`,
    );
  };
}

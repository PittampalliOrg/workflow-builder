/**
 * Dapr durable workflow — the agent loop.
 *
 * Direct port of Python `agent_workflow` generator at durable.py:237-455.
 * The Dapr Workflow runtime replays this generator on recovery; all
 * non-deterministic work happens inside activities.
 */

import type { WorkflowContext } from "@dapr/dapr";
import type { TriggerAction } from "../types/trigger.js";
import type { LlmCallResult } from "../llm/ai-sdk-adapter.js";
import type {
  RecordInitialEntryPayload,
  CallLlmPayload,
  RunToolPayload,
  SaveToolResultsPayload,
  FinalizeWorkflowPayload,
} from "./activities.js";

/** Type for the bound activity functions passed from DurableAgent. */
export interface AgentActivities {
  recordInitialEntry: (
    ctx: any,
    payload: RecordInitialEntryPayload,
  ) => Promise<void>;
  callLlm: (ctx: any, payload: CallLlmPayload) => Promise<LlmCallResult>;
  runTool: (
    ctx: any,
    payload: RunToolPayload,
  ) => Promise<{
    role: string;
    content: string;
    tool_call_id: string;
    name: string;
  }>;
  saveToolResults: (
    ctx: any,
    payload: SaveToolResultsPayload,
  ) => Promise<void>;
  finalizeWorkflow: (
    ctx: any,
    payload: FinalizeWorkflowPayload,
  ) => Promise<void>;
}

/**
 * Create the agent workflow generator function.
 *
 * Uses closure over bound activities to access agent state.
 * Mirrors Python agent_workflow at durable.py:237-455.
 */
export function createAgentWorkflow(
  activities: AgentActivities,
  maxIterations: number,
) {
  return async function* agentWorkflow(
    ctx: WorkflowContext,
    input: TriggerAction,
  ): AsyncGenerator<unknown, unknown, any> {
    const instanceId = ctx.getWorkflowInstanceId();
    const task = input.task ?? "Triggered without input.";

    // Extract metadata from trigger
    const metadata = input._message_metadata ?? {};
    const triggeringWorkflowInstanceId =
      input.workflow_instance_id ??
      (metadata.triggering_workflow_instance_id as string | undefined);
    const source = (metadata.source as string) ?? "direct";
    const traceContext = input._otel_span_context;

    // Step 1 — bootstrap state entry
    yield ctx.callActivity(activities.recordInitialEntry, {
      instanceId,
      inputValue: task,
      source,
      triggeringWorkflowInstanceId,
      startTime: new Date().toISOString(),
      traceContext,
    } satisfies RecordInitialEntryPayload);

    // Step 2 — ReAct-style agent loop
    let finalMessage: LlmCallResult | undefined;
    let turn = 0;

    try {
      for (turn = 1; turn <= maxIterations; turn++) {
        const assistantResponse: LlmCallResult = yield ctx.callActivity(
          activities.callLlm,
          {
            instanceId,
            // Only pass the user task on the first turn
            task: turn === 1 ? task : undefined,
          } satisfies CallLlmPayload,
        );

        const toolCalls = assistantResponse.tool_calls ?? [];

        if (toolCalls.length > 0) {
          // Parallel tool execution — each tool call is a separate activity
          const tasks = toolCalls.map((tc, idx) =>
            ctx.callActivity(activities.runTool, {
              toolCall: tc,
              instanceId,
              order: idx,
            } satisfies RunToolPayload),
          );
          const toolResults: Array<{
            role: string;
            content: string;
            tool_call_id: string;
            name: string;
          }> = yield ctx.whenAll(tasks);

          // Persist all tool results
          yield ctx.callActivity(activities.saveToolResults, {
            toolResults,
            instanceId,
          } satisfies SaveToolResultsPayload);

          // Continue to next LLM turn
          continue;
        }

        // No tool calls → this is the final answer
        finalMessage = assistantResponse;
        break;
      }

      // If we exhausted all turns without a final answer
      if (!finalMessage) {
        finalMessage = {
          role: "assistant",
          content:
            "I reached the maximum number of reasoning steps before I could finish. " +
            "Please rephrase or provide more detail so I can try again.",
        };
      }
    } catch (err) {
      console.error(`[agentWorkflow] Error:`, err);
      finalMessage = {
        role: "assistant",
        content: `Error: ${String(err)}`,
      };
    }

    // Step 3 — finalize
    yield ctx.callActivity(activities.finalizeWorkflow, {
      instanceId,
      finalOutput: finalMessage.content ?? "",
      endTime: new Date().toISOString(),
      triggeringWorkflowInstanceId,
    } satisfies FinalizeWorkflowPayload);

    return finalMessage;
  };
}

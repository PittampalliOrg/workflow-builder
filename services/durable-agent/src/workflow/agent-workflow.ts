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
import type { ToolCall } from "../types/tool.js";
import type {
  RecordInitialEntryPayload,
  CallLlmPayload,
  RunToolPayload,
  SaveToolResultsPayload,
  FinalizeWorkflowPayload,
} from "./activities.js";

/** Return type from the agent workflow, including accumulated tool history. */
export interface AgentWorkflowResult {
  role: "assistant";
  content: string | null;
  /** Final message's tool_calls (usually empty — final turn is text). */
  tool_calls?: ToolCall[];
  /** All tool calls accumulated across every turn. */
  all_tool_calls: Array<{
    tool_name: string;
    tool_args: Record<string, unknown>;
    execution_result: unknown;
  }>;
  /** Final text answer extracted for convenience. */
  final_answer: string;
}

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
    // Per-request override, fall back to closure default
    const effectiveMaxIterations = input.maxIterations ?? maxIterations;

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
      startTime: ctx.getCurrentUtcDateTime().toISOString(),
      traceContext,
    } satisfies RecordInitialEntryPayload);

    // Step 2 — ReAct-style agent loop
    let finalMessage: LlmCallResult | undefined;
    let turn = 0;

    // Accumulate all tool calls across every turn
    const allToolCalls: AgentWorkflowResult["all_tool_calls"] = [];

    // Track previous turn's tool results for crash recovery repair.
    // These are durable (stored in Dapr's event log as activity outputs).
    let previousToolResults:
      | Array<{ role: string; content: string; tool_call_id: string; name: string }>
      | undefined;

    try {
      for (turn = 1; turn <= effectiveMaxIterations; turn++) {
        const assistantResponse: LlmCallResult = yield ctx.callActivity(
          activities.callLlm,
          {
            instanceId,
            // Only pass the user task on the first turn
            task: turn === 1 ? task : undefined,
            // Pass previous tool results so callLlm can repair state after crashes
            previousToolResults,
          } satisfies CallLlmPayload,
        );
        // Clear after passing — only needed for the first callLlm after tool execution
        previousToolResults = undefined;

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

          // Accumulate tool calls with their results for the workflow output
          for (let j = 0; j < toolCalls.length; j++) {
            const tc = toolCalls[j];
            const tr = toolResults[j];
            let parsedArgs: Record<string, unknown> = {};
            try {
              parsedArgs = JSON.parse(tc.function.arguments);
            } catch { /* keep empty */ }

            let parsedResult: unknown;
            try {
              parsedResult = JSON.parse(tr?.content ?? "null");
            } catch {
              parsedResult = tr?.content ?? null;
            }

            allToolCalls.push({
              tool_name: tc.function.name,
              tool_args: parsedArgs,
              execution_result: parsedResult,
            });
          }

          // Persist all tool results
          yield ctx.callActivity(activities.saveToolResults, {
            toolResults,
            instanceId,
          } satisfies SaveToolResultsPayload);

          // Carry tool results forward for crash recovery repair.
          // If the pod crashes between saveToolResults and the next callLlm,
          // the generator will replay with these cached results and pass them
          // to callLlm to repair the conversation state in Redis.
          previousToolResults = toolResults;

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
      endTime: ctx.getCurrentUtcDateTime().toISOString(),
      triggeringWorkflowInstanceId,
    } satisfies FinalizeWorkflowPayload);

    // Return full result including accumulated tool history
    const result: AgentWorkflowResult = {
      role: finalMessage.role,
      content: finalMessage.content,
      tool_calls: finalMessage.tool_calls,
      all_tool_calls: allToolCalls,
      final_answer: finalMessage.content ?? "",
    };
    return result;
  };
}

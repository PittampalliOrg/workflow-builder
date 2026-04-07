import type { LoopPolicy } from "./loop-policy.js";
import type { LoopStepRecord } from "./loop-policy.js";
import type { ToolCall } from "./tool.js";

export interface AgentWorkflowResumeState {
  completedTurns: number;
  lastContinueAtTurn: number;
  stepHistory: LoopStepRecord[];
  allToolCalls: Array<{
    tool_name: string;
    tool_args: Record<string, unknown>;
    execution_result: unknown;
  }>;
  previousToolResults?: Array<{
    role: string;
    content: string;
    tool_call_id: string;
    name: string;
  }>;
  previousAssistantTurn?: {
    content?: string | null;
    toolCalls?: ToolCall[];
  };
  compactionCount: number;
  contextOverflowRecovered: boolean;
  lastCompactionReason?: string;
}

/**
 * Trigger and messaging types for agent communication.
 * Mirrors Python dapr_agents/agents/schemas.py.
 */

/** Payload used to trigger a workflow run. */
export interface TriggerAction {
  task?: string;
  /** Optional original prompt when a wrapper workflow builds the final task. */
  prompt?: string;
  workflow_instance_id?: string;
  /** Optional workspace context propagated into tool args. */
  workspaceRef?: string;
  /** Optional parent execution id propagated into tool args. */
  executionId?: string;
  /** Workflow-builder workflow id for correlated result shaping. */
  workflowId?: string;
  /** SW task/node id for correlated result shaping. */
  nodeId?: string;
  /** Parent workflow instance id for native child-workflow correlation. */
  parentExecutionId?: string;
  /** Run-scoped stop condition used for prompt shaping and file guards. */
  stopCondition?: string;
  /** Optional repository root context for prompt shaping. */
  cwd?: string;
  /** Whether completion requires real file mutations before succeeding. */
  requireFileChanges?: boolean;
  /** Optional logical timeout for parent workflows. */
  timeoutMinutes?: number;
  /** Per-request agent config payload mirrored from workflow-builder. */
  agentConfig?: Record<string, unknown>;
  /** Per-request max iterations override (falls back to agent default). */
  maxIterations?: number;
  /** Declarative loop controls (stopWhen + prepareStep style options). */
  loopPolicy?: LoopPolicy;
  /** Optional composable agent graph persisted by workflow-builder. */
  agentGraph?: Record<string, unknown>;
  /** Optional loop strategy name for graph-guided or custom runtime behavior. */
  loopStrategyName?: string;
  /** Message metadata propagated through pub/sub. */
  _message_metadata?: {
    source?: string;
    triggering_workflow_instance_id?: string;
    [key: string]: unknown;
  };
  /** OpenTelemetry span context for distributed tracing. */
  _otel_span_context?: Record<string, unknown>;
  /** Durable resume cursor used for continue-as-new history rollover. */
  _resume_state?: AgentWorkflowResumeState;
}

/** Broadcast message sent to all team agents via pub/sub. */
export interface BroadcastMessage {
  role: string;
  content: string;
  name?: string;
}

/** Response sent back to the triggering agent after task completion. */
export interface AgentTaskResponse {
  role: string;
  content: string;
  name?: string;
  workflow_instance_id?: string;
}

/**
 * Dynamic Workflow Interpreter
 *
 * A single workflow function that interprets and executes any WorkflowDefinition.
 * Instead of generating separate workflow code for each definition, this interpreter
 * walks through the definition's execution order and handles each node type dynamically.
 *
 * This approach offers several advantages:
 * 1. No code generation or registration needed per workflow
 * 2. Workflow definitions can be updated without redeploying
 * 3. All workflow logic is centralized and testable
 */
import type { TWorkflow, WorkflowContext } from "@dapr/dapr";
import {
  type ExecuteActionInput,
  executeAction,
} from "../activities/execute-action.js";
import {
  logApprovalRequest,
  logApprovalResponse,
  logApprovalTimeout,
} from "../activities/log-external-event.js";
import {
  type PersistStateInput,
  persistState,
} from "../activities/persist-state.js";
import {
  type PhaseChangedInput,
  publishPhaseChanged,
} from "../activities/publish-event.js";
import type { NodeOutputs } from "../core/template-resolver.js";
import type {
  ActivityExecutionResult,
  ApprovalGateConfig,
  DynamicWorkflowInput,
  DynamicWorkflowOutput,
  SerializedNode,
  TimerConfig,
  WorkflowCustomStatus,
} from "../core/types.js";

/**
 * Current status storage (since Dapr doesn't have getCustomStatus)
 */
let currentStatus: WorkflowCustomStatus = {
  phase: "pending",
  progress: 0,
};

/**
 * Update workflow custom status
 */
function updateStatus(
  ctx: WorkflowContext,
  status: Partial<WorkflowCustomStatus>
): void {
  currentStatus = { ...currentStatus, ...status };
  ctx.setCustomStatus(JSON.stringify(currentStatus));
}

/**
 * Calculate progress percentage based on completed nodes
 */
function calculateProgress(completedNodes: number, totalNodes: number): number {
  if (totalNodes === 0) {
    return 100;
  }
  return Math.round((completedNodes / totalNodes) * 100);
}

/**
 * Get timeout in seconds from various config formats
 */
function getTimeoutSeconds(config: ApprovalGateConfig | TimerConfig): number {
  if ("timeoutSeconds" in config && config.timeoutSeconds) {
    return config.timeoutSeconds;
  }
  if ("timeoutHours" in config && config.timeoutHours) {
    return config.timeoutHours * 3600;
  }
  if ("durationSeconds" in config && config.durationSeconds) {
    return config.durationSeconds;
  }
  if ("durationMinutes" in config && config.durationMinutes) {
    return config.durationMinutes * 60;
  }
  if ("durationHours" in config && config.durationHours) {
    return config.durationHours * 3600;
  }
  // Default: 24 hours for approval gates, 60 seconds for timers
  return "eventName" in config ? 86_400 : 60;
}

/**
 * Process an action/activity node
 */
async function* processActionNode(
  ctx: WorkflowContext,
  node: SerializedNode,
  nodeOutputs: NodeOutputs,
  executionId: string,
  workflowId: string,
  integrations?: Record<string, Record<string, string>>,
  dbExecutionId?: string
): AsyncGenerator<unknown, ActivityExecutionResult, unknown> {
  const input: ExecuteActionInput = {
    node,
    nodeOutputs,
    executionId,
    workflowId,
    integrations,
    dbExecutionId, // Database execution ID for logging
  };

  console.log(`[Dynamic Workflow] Executing action node: ${node.label}`);

  // Call the activity executor
  const result = (yield ctx.callActivity(
    executeAction,
    input
  )) as ActivityExecutionResult;

  return result;
}

/**
 * Process an approval gate node
 */
async function* processApprovalGateNode(
  ctx: WorkflowContext,
  node: SerializedNode,
  executionId: string,
  workflowId: string,
  dbExecutionId?: string
): AsyncGenerator<
  unknown,
  { approved: boolean; reason?: string; respondedBy?: string },
  unknown
> {
  const config = node.config as unknown as ApprovalGateConfig;
  const eventName = config.eventName || `approval_${node.id}`;
  const timeoutSeconds = getTimeoutSeconds(config);

  console.log(
    `[Dynamic Workflow] Waiting for approval event: ${eventName} (timeout: ${timeoutSeconds}s)`
  );

  // Log approval request to database for audit trail
  if (dbExecutionId) {
    yield ctx.callActivity(logApprovalRequest, {
      executionId: dbExecutionId,
      nodeId: node.id,
      eventName,
      timeoutSeconds,
    });
  }

  // Publish that we're waiting for approval
  yield ctx.callActivity(publishPhaseChanged, {
    workflowId,
    executionId,
    phase: "awaiting_approval",
    progress: 50,
    message: `Waiting for approval: ${node.label}`,
  } as PhaseChangedInput);

  // Wait for approval event or timeout
  const approvalPromise = ctx.waitForExternalEvent(eventName);
  const timeoutPromise = ctx.createTimer(timeoutSeconds);

  const winner = yield ctx.whenAny([approvalPromise, timeoutPromise]);

  if (winner === timeoutPromise) {
    console.log(`[Dynamic Workflow] Approval timed out: ${eventName}`);

    // Log timeout event to database for audit trail
    if (dbExecutionId) {
      yield ctx.callActivity(logApprovalTimeout, {
        executionId: dbExecutionId,
        nodeId: node.id,
        eventName,
        timeoutSeconds,
      });
    }

    return {
      approved: false,
      reason: `Timed out after ${timeoutSeconds} seconds`,
    };
  }

  // Get the approval result
  const approvalResult = approvalPromise.getResult() as {
    approved?: boolean;
    reason?: string;
    respondedBy?: string;
  };

  console.log(
    `[Dynamic Workflow] Approval received: ${eventName}`,
    approvalResult
  );

  // Log approval response to database for audit trail
  if (dbExecutionId) {
    yield ctx.callActivity(logApprovalResponse, {
      executionId: dbExecutionId,
      nodeId: node.id,
      eventName,
      approved: approvalResult?.approved ?? false,
      reason: approvalResult?.reason,
      respondedBy: approvalResult?.respondedBy,
      payload: approvalResult as Record<string, unknown>,
    });
  }

  return {
    approved: approvalResult?.approved ?? false,
    reason: approvalResult?.reason,
    respondedBy: approvalResult?.respondedBy,
  };
}

/**
 * Process a timer node
 */
async function* processTimerNode(
  ctx: WorkflowContext,
  node: SerializedNode
): AsyncGenerator<unknown, { completed: boolean }, unknown> {
  const config = node.config as TimerConfig;
  const durationSeconds = getTimeoutSeconds(config);

  console.log(
    `[Dynamic Workflow] Starting timer: ${node.label} (${durationSeconds}s)`
  );

  yield ctx.createTimer(durationSeconds);

  console.log(`[Dynamic Workflow] Timer completed: ${node.label}`);

  return { completed: true };
}

/**
 * Process a condition node (placeholder for future branching logic)
 */
async function* processConditionNode(
  _ctx: WorkflowContext,
  node: SerializedNode,
  _nodeOutputs: NodeOutputs
): AsyncGenerator<unknown, { result: boolean; branch: string }, unknown> {
  // TODO: Implement condition evaluation logic
  // For now, always return true
  console.log(`[Dynamic Workflow] Evaluating condition: ${node.label}`);

  return {
    result: true,
    branch: "true",
  };
}

/**
 * Dynamic Workflow - The main interpreter function
 *
 * This workflow function interprets a WorkflowDefinition and executes
 * each node in the specified execution order.
 */
export const dynamicWorkflow: TWorkflow = async function* (
  ctx: WorkflowContext,
  input: DynamicWorkflowInput
): AsyncGenerator<unknown, DynamicWorkflowOutput, unknown> {
  const { definition, triggerData, integrations, dbExecutionId } = input;
  const startTime = Date.now();
  const executionId = ctx.getWorkflowInstanceId();
  const workflowId = definition.id;

  console.log(
    `[Dynamic Workflow] Starting workflow: ${definition.name} (${executionId})`
  );

  // Initialize node outputs with trigger data
  const nodeOutputs: NodeOutputs = {
    trigger: { label: "Trigger", data: triggerData },
  };

  // Set initial status
  updateStatus(ctx, {
    phase: "running",
    progress: 0,
    message: "Workflow started",
  });

  // Create a map of nodes for quick lookup
  const nodeMap = new Map(definition.nodes.map((n) => [n.id, n]));
  const totalNodes = definition.executionOrder.length;
  let completedNodes = 0;

  try {
    // Execute nodes in order
    for (const nodeId of definition.executionOrder) {
      const node = nodeMap.get(nodeId);
      if (!node) {
        console.warn(`[Dynamic Workflow] Node not found: ${nodeId}`);
        continue;
      }

      // Skip disabled nodes
      if (node.enabled === false) {
        console.log(`[Dynamic Workflow] Skipping disabled node: ${node.label}`);
        completedNodes++;
        continue;
      }

      // Update status with current node
      updateStatus(ctx, {
        progress: calculateProgress(completedNodes, totalNodes),
        message: `Executing: ${node.label}`,
        currentNodeId: node.id,
        currentNodeName: node.label,
      });

      console.log(
        `[Dynamic Workflow] Processing node: ${node.label} (${node.type})`
      );

      let nodeResult: unknown;

      switch (node.type) {
        case "action":
        case "activity": {
          const result = yield* processActionNode(
            ctx,
            node,
            nodeOutputs,
            executionId,
            workflowId,
            integrations,
            dbExecutionId
          );
          nodeResult = result;

          if (!result.success) {
            // Check if this is a fatal error or if we should continue
            const continueOnError = node.config?.continueOnError === true;
            if (!continueOnError) {
              throw new Error(result.error || `Action failed: ${node.label}`);
            }
            console.warn(
              `[Dynamic Workflow] Action failed but continuing: ${result.error}`
            );
          }
          break;
        }

        case "approval-gate": {
          const result = yield* processApprovalGateNode(
            ctx,
            node,
            executionId,
            workflowId,
            dbExecutionId
          );
          nodeResult = result;

          if (!result.approved) {
            updateStatus(ctx, {
              phase: "rejected",
              progress: calculateProgress(completedNodes, totalNodes),
              message: `Rejected: ${result.reason || "No reason provided"}`,
            });

            return {
              success: false,
              outputs: nodeOutputs,
              error: `Workflow rejected at ${node.label}: ${result.reason}`,
              durationMs: Date.now() - startTime,
              phase: "rejected",
            };
          }
          break;
        }

        case "timer": {
          const result = yield* processTimerNode(ctx, node);
          nodeResult = result;
          break;
        }

        case "condition": {
          const result = yield* processConditionNode(ctx, node, nodeOutputs);
          nodeResult = result;
          // TODO: Handle branching based on condition result
          break;
        }

        case "trigger":
          // Trigger nodes are just entry points, skip them
          nodeResult = triggerData;
          break;

        case "publish-event": {
          // Publish an event to a topic
          const eventConfig = node.config as {
            topic?: string;
            eventType?: string;
            data?: Record<string, unknown>;
          };

          const topic = eventConfig.topic || "workflow.events";
          const eventType = eventConfig.eventType || "custom";

          yield ctx.callActivity(publishPhaseChanged, {
            workflowId,
            executionId,
            phase: "running",
            progress: calculateProgress(completedNodes, totalNodes),
            message: `Published event: ${eventType}`,
          } as PhaseChangedInput);

          nodeResult = { published: true, topic, eventType };
          break;
        }

        default:
          console.warn(
            `[Dynamic Workflow] Unknown node type: ${node.type}, skipping`
          );
          nodeResult = { skipped: true, reason: `Unknown type: ${node.type}` };
      }

      // Store node output
      nodeOutputs[node.id] = {
        label: node.label,
        data: nodeResult,
      };

      completedNodes++;
    }

    // Workflow completed successfully
    const durationMs = Date.now() - startTime;

    updateStatus(ctx, {
      phase: "completed",
      progress: 100,
      message: "Workflow completed successfully",
      currentNodeId: undefined,
      currentNodeName: undefined,
    });

    // Persist final outputs
    yield ctx.callActivity(persistState, {
      key: `workflow:${workflowId}:${executionId}:outputs`,
      value: nodeOutputs,
    } as PersistStateInput);

    console.log(
      `[Dynamic Workflow] Completed workflow: ${definition.name} (${durationMs}ms)`
    );

    return {
      success: true,
      outputs: Object.fromEntries(
        Object.entries(nodeOutputs).map(([k, v]) => [k, v.data])
      ),
      durationMs,
      phase: "completed",
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    console.error("[Dynamic Workflow] Workflow failed:", error);

    updateStatus(ctx, {
      phase: "failed",
      progress: calculateProgress(completedNodes, totalNodes),
      message: `Error: ${errorMessage}`,
    });

    return {
      success: false,
      outputs: Object.fromEntries(
        Object.entries(nodeOutputs).map(([k, v]) => [k, v.data])
      ),
      error: errorMessage,
      durationMs,
      phase: "failed",
    };
  }
};

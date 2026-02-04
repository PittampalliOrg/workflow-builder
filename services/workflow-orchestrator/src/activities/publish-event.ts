/**
 * Publish Event Activity
 *
 * Publishes events to Dapr pub/sub for workflow phase transitions
 * and inter-service communication.
 */
import { DaprClient } from "@dapr/dapr";
import type { WorkflowPhase } from "../core/types.js";

const PUBSUB_NAME = process.env.PUBSUB_NAME || "workflowpubsub";
const DAPR_HOST = process.env.DAPR_HOST || "localhost";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";

/**
 * Input for the publish event activity
 */
export interface PublishEventInput {
  topic: string;
  eventType: string;
  data: Record<string, unknown>;
  metadata?: Record<string, string>;
}

/**
 * Output from the publish event activity
 */
export interface PublishEventOutput {
  success: boolean;
  topic: string;
  eventType: string;
  error?: string;
}

/**
 * Publish an event to the specified topic
 *
 * Note: Dapr activities receive (ctx, input) but we don't need the ctx here
 */
export async function publishEvent(
  _ctx: unknown,
  input: PublishEventInput
): Promise<PublishEventOutput> {
  const { topic, eventType, data, metadata } = input;

  console.log(`[Publish Event] Publishing ${eventType} to topic: ${topic}`);

  try {
    const client = new DaprClient({
      daprHost: DAPR_HOST,
      daprPort: DAPR_HTTP_PORT,
    });

    const eventPayload = {
      type: eventType,
      source: "workflow-orchestrator",
      data,
      time: new Date().toISOString(),
      specversion: "1.0",
      datacontenttype: "application/json",
      ...metadata,
    };

    await client.pubsub.publish(PUBSUB_NAME, topic, eventPayload);

    console.log(
      `[Publish Event] Successfully published ${eventType} to ${topic}`
    );

    return {
      success: true,
      topic,
      eventType,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);

    console.error(
      `[Publish Event] Failed to publish ${eventType} to ${topic}:`,
      error
    );

    return {
      success: false,
      topic,
      eventType,
      error: `Failed to publish event: ${errorMessage}`,
    };
  }
}

/**
 * Workflow event types
 */
export const WorkflowEventTypes = {
  WORKFLOW_STARTED: "workflow.started",
  WORKFLOW_COMPLETED: "workflow.completed",
  WORKFLOW_FAILED: "workflow.failed",
  WORKFLOW_PHASE_CHANGED: "workflow.phase.changed",
  NODE_STARTED: "workflow.node.started",
  NODE_COMPLETED: "workflow.node.completed",
  NODE_FAILED: "workflow.node.failed",
  APPROVAL_REQUESTED: "workflow.approval.requested",
  APPROVAL_RECEIVED: "workflow.approval.received",
} as const;

/**
 * Default topic for workflow events
 */
export const WORKFLOW_EVENTS_TOPIC = "workflow.events";

/**
 * Input for workflow started event
 */
export interface WorkflowStartedInput {
  workflowId: string;
  executionId: string;
  workflowName: string;
}

/**
 * Publish a workflow started event
 */
export async function publishWorkflowStarted(
  _ctx: unknown,
  input: WorkflowStartedInput
): Promise<PublishEventOutput> {
  return publishEvent(null, {
    topic: WORKFLOW_EVENTS_TOPIC,
    eventType: WorkflowEventTypes.WORKFLOW_STARTED,
    data: {
      workflowId: input.workflowId,
      executionId: input.executionId,
      workflowName: input.workflowName,
      timestamp: new Date().toISOString(),
    },
  });
}

/**
 * Input for workflow completed event
 */
export interface WorkflowCompletedInput {
  workflowId: string;
  executionId: string;
  outputs: Record<string, unknown>;
}

/**
 * Publish a workflow completed event
 */
export async function publishWorkflowCompleted(
  _ctx: unknown,
  input: WorkflowCompletedInput
): Promise<PublishEventOutput> {
  return publishEvent(null, {
    topic: WORKFLOW_EVENTS_TOPIC,
    eventType: WorkflowEventTypes.WORKFLOW_COMPLETED,
    data: {
      workflowId: input.workflowId,
      executionId: input.executionId,
      outputs: input.outputs,
      timestamp: new Date().toISOString(),
    },
  });
}

/**
 * Input for workflow failed event
 */
export interface WorkflowFailedInput {
  workflowId: string;
  executionId: string;
  error: string;
}

/**
 * Publish a workflow failed event
 */
export async function publishWorkflowFailed(
  _ctx: unknown,
  input: WorkflowFailedInput
): Promise<PublishEventOutput> {
  return publishEvent(null, {
    topic: WORKFLOW_EVENTS_TOPIC,
    eventType: WorkflowEventTypes.WORKFLOW_FAILED,
    data: {
      workflowId: input.workflowId,
      executionId: input.executionId,
      error: input.error,
      timestamp: new Date().toISOString(),
    },
  });
}

/**
 * Input for phase changed event
 */
export interface PhaseChangedInput {
  workflowId: string;
  executionId: string;
  phase: WorkflowPhase;
  progress: number;
  message?: string;
}

/**
 * Publish a phase change event
 */
export async function publishPhaseChanged(
  _ctx: unknown,
  input: PhaseChangedInput
): Promise<PublishEventOutput> {
  return publishEvent(null, {
    topic: WORKFLOW_EVENTS_TOPIC,
    eventType: WorkflowEventTypes.WORKFLOW_PHASE_CHANGED,
    data: {
      workflowId: input.workflowId,
      executionId: input.executionId,
      phase: input.phase,
      progress: input.progress,
      message: input.message,
      timestamp: new Date().toISOString(),
    },
  });
}

/**
 * Input for approval requested event
 */
export interface ApprovalRequestedInput {
  workflowId: string;
  executionId: string;
  nodeId: string;
  nodeName: string;
  eventName: string;
  timeoutSeconds: number;
}

/**
 * Publish an approval requested event
 */
export async function publishApprovalRequested(
  _ctx: unknown,
  input: ApprovalRequestedInput
): Promise<PublishEventOutput> {
  return publishEvent(null, {
    topic: WORKFLOW_EVENTS_TOPIC,
    eventType: WorkflowEventTypes.APPROVAL_REQUESTED,
    data: {
      workflowId: input.workflowId,
      executionId: input.executionId,
      nodeId: input.nodeId,
      nodeName: input.nodeName,
      eventName: input.eventName,
      timeoutSeconds: input.timeoutSeconds,
      expiresAt: new Date(Date.now() + input.timeoutSeconds * 1000).toISOString(),
      timestamp: new Date().toISOString(),
    },
  });
}

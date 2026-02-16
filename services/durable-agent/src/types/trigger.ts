/**
 * Trigger and messaging types for agent communication.
 * Mirrors Python dapr_agents/agents/schemas.py.
 */

/** Payload used to trigger a workflow run. */
export interface TriggerAction {
  task?: string;
  workflow_instance_id?: string;
  /** Per-request max iterations override (falls back to agent default). */
  maxIterations?: number;
  /** Message metadata propagated through pub/sub. */
  _message_metadata?: {
    source?: string;
    triggering_workflow_instance_id?: string;
    [key: string]: unknown;
  };
  /** OpenTelemetry span context for distributed tracing. */
  _otel_span_context?: Record<string, unknown>;
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

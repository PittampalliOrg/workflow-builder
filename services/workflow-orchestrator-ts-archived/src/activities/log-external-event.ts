/**
 * Log External Event Activity
 *
 * Persists external event records (approval requests, responses, timeouts)
 * to the database for audit trail purposes.
 *
 * Uses Dapr service invocation to call function-router which has database access.
 */
import { DaprClient, HttpMethod } from "@dapr/dapr";

const DAPR_HOST = process.env.DAPR_HOST || "localhost";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";
const FUNCTION_ROUTER_APP_ID =
  process.env.FUNCTION_ROUTER_APP_ID || "function-router";

/**
 * External event types
 */
export type ExternalEventType =
  | "approval_request"
  | "approval_response"
  | "timeout";

/**
 * Input for logging an external event
 */
export type LogExternalEventInput = {
  executionId: string; // Database execution ID
  nodeId: string;
  eventName: string;
  eventType: ExternalEventType;
  timeoutSeconds?: number;
  approved?: boolean;
  reason?: string;
  respondedBy?: string;
  payload?: Record<string, unknown>;
};

/**
 * Output from logging an external event
 */
export type LogExternalEventOutput = {
  success: boolean;
  eventId?: string;
  error?: string;
};

/**
 * Log an external event to the database
 *
 * This activity calls the function-router's /external-event endpoint
 * to persist the event record.
 */
export async function logExternalEvent(
  _ctx: unknown,
  input: LogExternalEventInput
): Promise<LogExternalEventOutput> {
  const { executionId, nodeId, eventName, eventType } = input;

  console.log(
    `[Log External Event] Logging ${eventType} for event: ${eventName} (execution: ${executionId})`
  );

  try {
    const client = new DaprClient({
      daprHost: DAPR_HOST,
      daprPort: DAPR_HTTP_PORT,
    });

    const requestPayload = {
      execution_id: executionId,
      node_id: nodeId,
      event_name: eventName,
      event_type: eventType,
      timeout_seconds: input.timeoutSeconds,
      approved: input.approved,
      reason: input.reason,
      responded_by: input.respondedBy,
      payload: input.payload,
    };

    const result = (await client.invoker.invoke(
      FUNCTION_ROUTER_APP_ID,
      "external-event",
      HttpMethod.POST,
      requestPayload
    )) as { success: boolean; event_id?: string; error?: string };

    if (!result.success) {
      console.warn(
        `[Log External Event] Failed to log ${eventType}: ${result.error}`
      );
      return {
        success: false,
        error: result.error,
      };
    }

    console.log(
      `[Log External Event] Successfully logged ${eventType}: ${result.event_id}`
    );

    return {
      success: true,
      eventId: result.event_id,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    console.error(`[Log External Event] Error logging ${eventType}:`, error);

    // Don't throw - audit logging failure shouldn't break workflow execution
    return {
      success: false,
      error: `Failed to log external event: ${errorMessage}`,
    };
  }
}

/**
 * Helper to log an approval request event
 */
export async function logApprovalRequest(
  _ctx: unknown,
  input: {
    executionId: string;
    nodeId: string;
    eventName: string;
    timeoutSeconds: number;
  }
): Promise<LogExternalEventOutput> {
  return logExternalEvent(null, {
    executionId: input.executionId,
    nodeId: input.nodeId,
    eventName: input.eventName,
    eventType: "approval_request",
    timeoutSeconds: input.timeoutSeconds,
  });
}

/**
 * Helper to log an approval response event
 */
export async function logApprovalResponse(
  _ctx: unknown,
  input: {
    executionId: string;
    nodeId: string;
    eventName: string;
    approved: boolean;
    reason?: string;
    respondedBy?: string;
    payload?: Record<string, unknown>;
  }
): Promise<LogExternalEventOutput> {
  return logExternalEvent(null, {
    executionId: input.executionId,
    nodeId: input.nodeId,
    eventName: input.eventName,
    eventType: "approval_response",
    approved: input.approved,
    reason: input.reason,
    respondedBy: input.respondedBy,
    payload: input.payload,
  });
}

/**
 * Helper to log a timeout event
 */
export async function logApprovalTimeout(
  _ctx: unknown,
  input: {
    executionId: string;
    nodeId: string;
    eventName: string;
    timeoutSeconds: number;
  }
): Promise<LogExternalEventOutput> {
  return logExternalEvent(null, {
    executionId: input.executionId,
    nodeId: input.nodeId,
    eventName: input.eventName,
    eventType: "timeout",
    timeoutSeconds: input.timeoutSeconds,
    reason: `Timed out after ${input.timeoutSeconds} seconds`,
  });
}

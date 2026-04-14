import { fetch as undiciFetch } from "undici";
import { getSql } from "./db.js";

type JsonRecord = Record<string, unknown>;

export type DaprAgentPyTrackingContext = {
  workflowExecutionId: string;
  workflowId: string;
  nodeId: string;
  nodeName?: string;
  daprInstanceId: string;
  parentExecutionId: string;
  workspaceRef?: string;
  sandboxName?: string;
};

type AgentEventInput = {
  sourceEventId: string;
  eventType:
    | "run_started"
    | "llm_complete"
    | "tool_call_start"
    | "tool_call_end"
    | "tool_call_error"
    | "run_complete"
    | "run_error";
  payload: JsonRecord;
  ts?: string;
  toolName?: string | null;
  phase?: string | null;
};

const DAPR_HOST = process.env.DAPR_HOST || "localhost";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";
const PUBSUB_NAME = process.env.PUBSUB_NAME || "pubsub";

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseJson(value: unknown): unknown {
  const text = asString(value);
  if (!text) return value;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return value;
  }
}

function eventTimestamp(value: unknown): string {
  const text = asString(value);
  if (!text) return new Date().toISOString();
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function toolCallsFromMessage(message: JsonRecord): JsonRecord[] {
  return Array.isArray(message.tool_calls)
    ? message.tool_calls.filter(isRecord)
    : [];
}

function toolCallName(call: JsonRecord): string | undefined {
  return isRecord(call.function) ? asString(call.function.name) : undefined;
}

function toolCallArgs(call: JsonRecord): unknown {
  return isRecord(call.function) ? parseJson(call.function.arguments) : undefined;
}

function buildSnapshotEvents(
  ctx: DaprAgentPyTrackingContext,
  snapshot: JsonRecord,
): AgentEventInput[] {
  const messages = Array.isArray(snapshot.messages)
    ? snapshot.messages.filter(isRecord)
    : [];
  const events: AgentEventInput[] = [
    {
      sourceEventId: `${ctx.daprInstanceId}:run_started`,
      eventType: "run_started",
      phase: "agent",
      payload: {
        type: "run_started",
        phase: "agent",
        instanceId: ctx.daprInstanceId,
        workflowExecutionId: ctx.workflowExecutionId,
        nodeId: ctx.nodeId,
        nodeName: ctx.nodeName,
        workspaceRef: ctx.workspaceRef,
        sandboxName: ctx.sandboxName,
      },
    },
  ];

  messages.forEach((message, index) => {
    const role = asString(message.role);
    const messageId = asString(message.id) || `${ctx.daprInstanceId}:message:${index}`;
    const timestamp = eventTimestamp(message.timestamp);

    if (role === "assistant") {
      const toolCalls = toolCallsFromMessage(message);
      events.push({
        sourceEventId: `${messageId}:llm_complete`,
        eventType: "llm_complete",
        phase: "agent",
        ts: timestamp,
        payload: {
          type: "llm_complete",
          phase: "agent",
          messageId,
          content: asString(message.content) || "",
          toolCalls: toolCalls.map(toolCallName).filter(Boolean),
        },
      });

      toolCalls.forEach((call, callIndex) => {
        const callId = asString(call.id) || `${messageId}:tool:${callIndex}`;
        const toolName = toolCallName(call) || "tool";
        events.push({
          sourceEventId: `${callId}:start`,
          eventType: "tool_call_start",
          phase: "agent",
          toolName,
          ts: timestamp,
          payload: {
            type: "tool_call_start",
            phase: "agent",
            messageId,
            callId,
            toolName,
            args: toolCallArgs(call),
          },
        });
      });
    }

    if (role === "tool") {
      const toolName = asString(message.name) || "tool";
      const content = asString(message.content) || "";
      const failed = /\b(failed|error|exception)\b/i.test(content);
      events.push({
        sourceEventId: `${messageId}:tool_end`,
        eventType: failed ? "tool_call_error" : "tool_call_end",
        phase: "agent",
        toolName,
        ts: timestamp,
        payload: {
          type: failed ? "tool_call_error" : "tool_call_end",
          phase: "agent",
          messageId,
          callId: asString(message.tool_call_id),
          toolName,
          success: !failed,
          output: failed ? undefined : content.slice(0, 4000),
          error: failed ? content.slice(0, 4000) : undefined,
        },
      });
    }
  });

  const status = asString(snapshot.status) || asString(snapshot.runtime_status);
  if (status === "completed" || status === "failed" || status === "canceled") {
    const eventType = status === "completed" ? "run_complete" : "run_error";
    events.push({
      sourceEventId: `${ctx.daprInstanceId}:${eventType}`,
      eventType,
      phase: "agent",
      payload: {
        type: eventType,
        phase: "agent",
        instanceId: ctx.daprInstanceId,
        status,
        output: snapshot.output ?? snapshot.serialized_output,
        error: snapshot.error ?? snapshot.failure_details,
      },
    });
  }

  return events;
}

async function publishEvent(ctx: DaprAgentPyTrackingContext, event: AgentEventInput) {
  const url = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/publish/${PUBSUB_NAME}/workflow.events.${encodeURIComponent(ctx.workflowExecutionId)}`;
  const body = JSON.stringify({
    source: "dapr-agent-py-tracker",
    type: event.eventType,
    executionId: ctx.workflowExecutionId,
    workflowAgentRunId: ctx.daprInstanceId,
    daprInstanceId: ctx.daprInstanceId,
    sourceEventId: event.sourceEventId,
    toolName: event.toolName,
    phase: event.phase,
    data: event.payload,
    timestamp: event.ts || new Date().toISOString(),
  });

  try {
    await undiciFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  } catch {
    // DB persistence is the durable path; live NATS delivery is best-effort.
  }
}

export async function ensureDaprAgentPyRun(
  ctx: DaprAgentPyTrackingContext,
  status: "scheduled" | "running" = "running",
): Promise<void> {
  if (!ctx.workflowExecutionId || !ctx.workflowId || !ctx.nodeId || !ctx.daprInstanceId) {
    return;
  }
  const sql = getSql();
  await sql`
    INSERT INTO workflow_agent_runs (
      id, workflow_execution_id, workflow_id, node_id, mode,
      agent_workflow_id, dapr_instance_id, parent_execution_id,
      workspace_ref, status, created_at, updated_at
    ) VALUES (
      ${ctx.daprInstanceId}, ${ctx.workflowExecutionId}, ${ctx.workflowId},
      ${ctx.nodeId}, 'run', ${ctx.daprInstanceId}, ${ctx.daprInstanceId},
      ${ctx.parentExecutionId || ctx.workflowExecutionId},
      ${ctx.workspaceRef ?? null}, ${status}, now(), now()
    )
    ON CONFLICT (dapr_instance_id) DO UPDATE
      SET status = CASE
        WHEN workflow_agent_runs.status IN ('completed', 'failed') THEN workflow_agent_runs.status
        ELSE EXCLUDED.status
      END,
      workspace_ref = COALESCE(workflow_agent_runs.workspace_ref, EXCLUDED.workspace_ref),
      updated_at = now()
  `;
}

export async function trackDaprAgentPySnapshot(
  ctx: DaprAgentPyTrackingContext,
  snapshot: unknown,
): Promise<void> {
  if (!isRecord(snapshot)) return;
  await ensureDaprAgentPyRun(ctx, "running");
  const sql = getSql();

	for (const event of buildSnapshotEvents(ctx, snapshot)) {
		const eventTime = event.ts || new Date().toISOString();
		const [inserted] = await sql<{ event_id: number }[]>`
			INSERT INTO workflow_agent_events (
				workflow_execution_id, workflow_agent_run_id, parent_execution_id,
        dapr_instance_id, source_event_id, event_type, phase, tool_name,
        sandbox_name, payload, ts
      ) VALUES (
				${ctx.workflowExecutionId}, ${ctx.daprInstanceId},
				${ctx.parentExecutionId || ctx.workflowExecutionId}, ${ctx.daprInstanceId},
				${event.sourceEventId}, ${event.eventType}, ${event.phase ?? null},
				${event.toolName ?? null}, ${ctx.sandboxName ?? null},
				${JSON.stringify(event.payload)}, ${eventTime}::timestamp
			)
      ON CONFLICT (workflow_execution_id, dapr_instance_id, source_event_id) DO NOTHING
      RETURNING event_id
    `;

    if (inserted?.event_id) {
      await sql`
        UPDATE workflow_executions
        SET last_agent_event_id = ${inserted.event_id}
        WHERE id = ${ctx.workflowExecutionId}
      `;
      await publishEvent(ctx, event);
    }
  }
}

export async function completeDaprAgentPyRun(
  ctx: DaprAgentPyTrackingContext,
  input: { success: boolean; result?: unknown; error?: string },
): Promise<void> {
  if (!ctx.workflowExecutionId || !ctx.daprInstanceId) return;
  const sql = getSql();
  await sql`
    UPDATE workflow_agent_runs
    SET status = ${input.success ? "completed" : "failed"},
      result = ${input.result === undefined ? null : JSON.stringify(input.result)},
      error = ${input.error ?? null},
      completed_at = now(),
      updated_at = now()
    WHERE dapr_instance_id = ${ctx.daprInstanceId}
  `;
}

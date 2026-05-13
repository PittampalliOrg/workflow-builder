import { context, propagation, trace, type Context } from "@opentelemetry/api";

const SESSION_ID_ATTRIBUTE = "session.id";
const WORKFLOW_EXECUTION_ATTRIBUTE = "workflow.execution.id";
const WORKFLOW_ID_ATTRIBUTE = "workflow.id";
const WORKFLOW_TRACE_GROUP_ATTRIBUTE = "workflow_builder.trace_group_id";

type WorkflowSessionContext = {
  sessionId?: string | null;
  workflowExecutionId?: string | null;
  workflowId?: string | null;
  traceGroupId?: string | null;
};

export function buildWorkflowSessionId(
  executionId: string | null | undefined,
): string | null {
  const normalized = typeof executionId === "string" ? executionId.trim() : "";
  return normalized.length > 0 ? normalized : null;
}

function clean(value: string | null | undefined): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 ? normalized : null;
}

export function bindWorkflowSessionContext(
  input: string | WorkflowSessionContext,
): Context {
  const workflowContext =
    typeof input === "string"
      ? {
          sessionId: input,
          workflowExecutionId: input,
          traceGroupId: input,
        }
      : {
          sessionId: clean(input.sessionId) ?? clean(input.workflowExecutionId),
          workflowExecutionId:
            clean(input.workflowExecutionId) ?? clean(input.sessionId),
          workflowId: clean(input.workflowId),
          traceGroupId:
            clean(input.traceGroupId) ??
            clean(input.workflowExecutionId) ??
            clean(input.sessionId),
        };
  const activeContext = context.active();
  const currentSpan = trace.getSpan(activeContext);
  const attrs: Record<string, string | null | undefined> = {
    [SESSION_ID_ATTRIBUTE]: workflowContext.sessionId,
    [WORKFLOW_EXECUTION_ATTRIBUTE]: workflowContext.workflowExecutionId,
    [WORKFLOW_ID_ATTRIBUTE]: workflowContext.workflowId,
    [WORKFLOW_TRACE_GROUP_ATTRIBUTE]: workflowContext.traceGroupId,
  };
  for (const [key, value] of Object.entries(attrs)) {
    if (value) currentSpan?.setAttribute(key, value);
  }

  const existingBaggage = propagation.getBaggage(activeContext);
  const nextEntries = {
    ...(existingBaggage
      ? Object.fromEntries(existingBaggage.getAllEntries())
      : {}),
    ...Object.fromEntries(
      Object.entries(attrs)
        .filter((entry): entry is [string, string] => Boolean(entry[1]))
        .map(([key, value]) => [key, { value }]),
    ),
  };
  const baggage = propagation.createBaggage(nextEntries);
  return propagation.setBaggage(activeContext, baggage);
}

export function sessionIdFromHeaders(
  headers: Record<string, unknown>,
): string | null {
  const explicit = headers["x-workflow-session-id"];
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return explicit.trim();
  }
  const baggageHeader = headers.baggage;
  if (typeof baggageHeader !== "string") return null;
  for (const part of baggageHeader.split(",")) {
    const [rawKey, rawValue] = part.split("=", 2);
    if (!rawKey || !rawValue) continue;
    if (
      rawKey.trim().toLowerCase() === SESSION_ID_ATTRIBUTE ||
      rawKey.trim().toLowerCase() === WORKFLOW_EXECUTION_ATTRIBUTE
    ) {
      const decoded = decodeURIComponent(rawValue.trim());
      return decoded.length > 0 ? decoded : null;
    }
  }
  return null;
}

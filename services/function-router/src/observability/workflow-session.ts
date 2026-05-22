import { context, propagation, trace, type Context } from "@opentelemetry/api";

const SESSION_ID_ATTRIBUTE = "session.id";
const WORKFLOW_EXECUTION_ATTRIBUTE = "workflow.execution.id";
const WORKFLOW_ID_ATTRIBUTE = "workflow.id";
const WORKFLOW_TRACE_GROUP_ATTRIBUTE = "workflow_builder.trace_group_id";
const WORKFLOW_ACTIVITY_ATTRIBUTE = "workflow.activity.correlation_id";

type WorkflowSessionContext = {
  sessionId?: string | null;
  workflowExecutionId?: string | null;
  workflowId?: string | null;
  traceGroupId?: string | null;
  activityCorrelationId?: string | null;
  nodeId?: string | null;
  nodeName?: string | null;
  nodeSequence?: string | number | null;
  actionType?: string | null;
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
  const workflowContext: WorkflowSessionContext =
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
          activityCorrelationId: clean(input.activityCorrelationId),
          nodeId: clean(input.nodeId),
          nodeName: clean(input.nodeName),
          nodeSequence:
            input.nodeSequence == null ? null : clean(String(input.nodeSequence)),
          actionType: clean(input.actionType),
        };
  const activeContext = context.active();
  const currentSpan = trace.getSpan(activeContext);
  const attrs: Record<string, string | null | undefined> = {
    [SESSION_ID_ATTRIBUTE]: workflowContext.sessionId,
    [WORKFLOW_EXECUTION_ATTRIBUTE]: workflowContext.workflowExecutionId,
    [WORKFLOW_ID_ATTRIBUTE]: workflowContext.workflowId,
    [WORKFLOW_TRACE_GROUP_ATTRIBUTE]: workflowContext.traceGroupId,
    [WORKFLOW_ACTIVITY_ATTRIBUTE]: workflowContext.activityCorrelationId,
    "workflow.node.id": workflowContext.nodeId,
    "workflow.node.name": workflowContext.nodeName,
    "workflow.node.sequence":
      workflowContext.nodeSequence == null ? null : String(workflowContext.nodeSequence),
    "workflow.node.action_type": workflowContext.actionType,
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

function scalar(value: unknown): string | undefined {
  const cleaned = clean(typeof value === "string" ? value : null);
  return cleaned ?? undefined;
}

function parseBaggageHeader(value: unknown): Record<string, string> {
  if (typeof value !== "string") return {};
  const out: Record<string, string> = {};
  for (const part of value.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    if (!key || !raw) continue;
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}

function workflowActivityContextFromCarrier(
  carrier: Record<string, unknown>,
): Partial<WorkflowSessionContext> {
  const baggage = parseBaggageHeader(carrier.baggage);
  return {
    sessionId: baggage[SESSION_ID_ATTRIBUTE] ?? scalar(carrier[SESSION_ID_ATTRIBUTE]),
    workflowExecutionId:
      baggage[WORKFLOW_EXECUTION_ATTRIBUTE] ??
      scalar(carrier[WORKFLOW_EXECUTION_ATTRIBUTE]),
    workflowId: baggage[WORKFLOW_ID_ATTRIBUTE] ?? scalar(carrier[WORKFLOW_ID_ATTRIBUTE]),
    traceGroupId:
      baggage[WORKFLOW_TRACE_GROUP_ATTRIBUTE] ??
      scalar(carrier[WORKFLOW_TRACE_GROUP_ATTRIBUTE]),
    activityCorrelationId:
      baggage[WORKFLOW_ACTIVITY_ATTRIBUTE] ??
      scalar(carrier[WORKFLOW_ACTIVITY_ATTRIBUTE]),
    nodeId: baggage["workflow.node.id"] ?? scalar(carrier["workflow.node.id"]),
    nodeName: baggage["workflow.node.name"] ?? scalar(carrier["workflow.node.name"]),
    nodeSequence:
      baggage["workflow.node.sequence"] ?? scalar(carrier["workflow.node.sequence"]),
    actionType:
      baggage["workflow.node.action_type"] ??
      scalar(carrier["workflow.node.action_type"]),
  };
}

export function workflowActivityContextFromHeaders(
  headers: Record<string, unknown>,
  fallbackCarrier?: Record<string, unknown> | null,
): Partial<WorkflowSessionContext> {
  const primary = workflowActivityContextFromCarrier(headers);
  const fallback = fallbackCarrier
    ? workflowActivityContextFromCarrier(fallbackCarrier)
    : {};
  return {
    sessionId: primary.sessionId ?? fallback.sessionId,
    workflowExecutionId:
      primary.workflowExecutionId ?? fallback.workflowExecutionId,
    workflowId: primary.workflowId ?? fallback.workflowId,
    traceGroupId: primary.traceGroupId ?? fallback.traceGroupId,
    activityCorrelationId:
      primary.activityCorrelationId ?? fallback.activityCorrelationId,
    nodeId: primary.nodeId ?? fallback.nodeId,
    nodeName: primary.nodeName ?? fallback.nodeName,
    nodeSequence: primary.nodeSequence ?? fallback.nodeSequence,
    actionType: primary.actionType ?? fallback.actionType,
  };
}

export function sessionIdFromHeaders(
  headers: Record<string, unknown>,
  fallbackCarrier?: Record<string, unknown> | null,
): string | null {
  const explicit = headers["x-workflow-session-id"];
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return explicit.trim();
  }
  const context = workflowActivityContextFromHeaders(headers, fallbackCarrier);
  return context.sessionId ?? context.workflowExecutionId ?? null;
}

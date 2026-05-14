import { randomBytes } from "node:crypto";
import { context, propagation, trace, type Context } from "@opentelemetry/api";

export const SESSION_ID_ATTRIBUTE = "session.id";
export const WORKFLOW_EXECUTION_ATTRIBUTE = "workflow.execution.id";
export const WORKFLOW_ID_ATTRIBUTE = "workflow.id";
export const DAPR_WORKFLOW_INSTANCE_ATTRIBUTE = "dapr.workflow.instance_id";
export const MLFLOW_EXPERIMENT_ATTRIBUTE = "mlflow.experiment_id";
export const MLFLOW_RUN_ATTRIBUTE = "mlflow.run_id";
export const MLFLOW_PARENT_RUN_ATTRIBUTE = "mlflow.parent_run_id";
export const MLFLOW_SESSION_ATTRIBUTE = "workflow_builder.mlflow_session_id";
export const MLFLOW_MODEL_ID_ATTRIBUTE = "mlflow.modelId";
export const MLFLOW_MODEL_URI_ATTRIBUTE = "mlflow.model.uri";
export const WORKFLOW_TRACE_GROUP_ATTRIBUTE = "workflow_builder.trace_group_id";

export type WorkflowSessionHeaderContext = {
  sessionId?: string | null;
  workflowExecutionId?: string | null;
  workflowId?: string | null;
  daprWorkflowInstanceId?: string | null;
  mlflowExperimentId?: string | null;
  mlflowRunId?: string | null;
  mlflowParentRunId?: string | null;
  mlflowSessionId?: string | null;
  mlflowModelId?: string | null;
  mlflowModelUri?: string | null;
  traceGroupId?: string | null;
};

type NormalizedWorkflowSessionContext = WorkflowSessionHeaderContext & {
  sessionId: string;
  workflowExecutionId: string;
  traceGroupId: string;
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

function mergeBaggageHeader(
  existing: string | undefined,
  attrs: Record<string, string | null | undefined>,
): string {
  const entries = new Map<string, string>();
  for (const part of (existing ?? "").split(",")) {
    const [rawKey, rawValue] = part.split("=", 2);
    const key = rawKey?.trim();
    if (!key || rawValue == null) continue;
    entries.set(key, rawValue.trim());
  }
  for (const [key, value] of Object.entries(attrs)) {
    if (!value) continue;
    entries.set(key, encodeURIComponent(value));
  }
  return Array.from(entries, ([key, value]) => `${key}=${value}`).join(",");
}

export function normalizeWorkflowSessionContext(
  input: string | WorkflowSessionHeaderContext,
): NormalizedWorkflowSessionContext {
  const raw = typeof input === "string" ? { sessionId: input } : input;
  const workflowExecutionId =
    clean(raw.workflowExecutionId) ?? clean(raw.sessionId) ?? "";
  const sessionId = clean(raw.sessionId) ?? workflowExecutionId;
  const traceGroupId = clean(raw.traceGroupId) ?? workflowExecutionId;
  return {
    sessionId,
    workflowExecutionId,
    traceGroupId,
    workflowId: clean(raw.workflowId),
    daprWorkflowInstanceId: clean(raw.daprWorkflowInstanceId),
    mlflowExperimentId: clean(raw.mlflowExperimentId),
    mlflowRunId: clean(raw.mlflowRunId),
    mlflowParentRunId: clean(raw.mlflowParentRunId),
    mlflowSessionId: clean(raw.mlflowSessionId),
    mlflowModelId: clean(raw.mlflowModelId),
    mlflowModelUri: clean(raw.mlflowModelUri),
  };
}

export function bindWorkflowSessionContext(
  input: string | WorkflowSessionHeaderContext,
): Context {
  const workflowContext = normalizeWorkflowSessionContext(input);
  const activeContext = context.active();
  const currentSpan = trace.getSpan(activeContext);
  const attrs: Record<string, string | null | undefined> = {
    [SESSION_ID_ATTRIBUTE]: workflowContext.sessionId,
    [WORKFLOW_EXECUTION_ATTRIBUTE]: workflowContext.workflowExecutionId,
    [WORKFLOW_TRACE_GROUP_ATTRIBUTE]: workflowContext.traceGroupId,
    [WORKFLOW_ID_ATTRIBUTE]: workflowContext.workflowId,
    [DAPR_WORKFLOW_INSTANCE_ATTRIBUTE]: workflowContext.daprWorkflowInstanceId,
    [MLFLOW_EXPERIMENT_ATTRIBUTE]: workflowContext.mlflowExperimentId,
    [MLFLOW_RUN_ATTRIBUTE]: workflowContext.mlflowRunId,
    [MLFLOW_PARENT_RUN_ATTRIBUTE]: workflowContext.mlflowParentRunId,
    [MLFLOW_SESSION_ATTRIBUTE]: workflowContext.mlflowSessionId,
    [MLFLOW_MODEL_ID_ATTRIBUTE]: workflowContext.mlflowModelId,
    [MLFLOW_MODEL_URI_ATTRIBUTE]: workflowContext.mlflowModelUri,
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

export function injectWorkflowSessionHeaders(
  headers: Record<string, string>,
  input: string | WorkflowSessionHeaderContext,
): Record<string, string> {
  const workflowContext = normalizeWorkflowSessionContext(input);
  const attrs: Record<string, string | null | undefined> = {
    [SESSION_ID_ATTRIBUTE]: workflowContext.sessionId,
    [WORKFLOW_EXECUTION_ATTRIBUTE]: workflowContext.workflowExecutionId,
    [WORKFLOW_TRACE_GROUP_ATTRIBUTE]: workflowContext.traceGroupId,
    [WORKFLOW_ID_ATTRIBUTE]: workflowContext.workflowId,
    [DAPR_WORKFLOW_INSTANCE_ATTRIBUTE]: workflowContext.daprWorkflowInstanceId,
    [MLFLOW_EXPERIMENT_ATTRIBUTE]: workflowContext.mlflowExperimentId,
    [MLFLOW_RUN_ATTRIBUTE]: workflowContext.mlflowRunId,
    [MLFLOW_PARENT_RUN_ATTRIBUTE]: workflowContext.mlflowParentRunId,
    [MLFLOW_SESSION_ATTRIBUTE]: workflowContext.mlflowSessionId,
    [MLFLOW_MODEL_ID_ATTRIBUTE]: workflowContext.mlflowModelId,
    [MLFLOW_MODEL_URI_ATTRIBUTE]: workflowContext.mlflowModelUri,
  };
  const sessionContext = bindWorkflowSessionContext(workflowContext);
  const nextHeaders = { ...headers };
  const explicitTraceparent = nextHeaders.traceparent;
  const explicitTracestate = nextHeaders.tracestate;
  propagation.inject(sessionContext, nextHeaders);
  if (explicitTraceparent) nextHeaders.traceparent = explicitTraceparent;
  if (explicitTracestate) nextHeaders.tracestate = explicitTracestate;
  const contextBaggage = propagation.getBaggage(sessionContext);
  const contextBaggageAttrs = contextBaggage
    ? Object.fromEntries(
        contextBaggage
          .getAllEntries()
          .map(([key, entry]) => [key, entry.value]),
      )
    : {};
  nextHeaders.baggage = mergeBaggageHeader(nextHeaders.baggage, {
    ...contextBaggageAttrs,
    ...attrs,
  });
  nextHeaders["x-workflow-session-id"] = workflowContext.sessionId;
  nextHeaders["x-workflow-execution-id"] = workflowContext.workflowExecutionId;
  nextHeaders["x-workflow-trace-group-id"] = workflowContext.traceGroupId;
  return nextHeaders;
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export function generateWorkflowTraceparent(): string {
  let traceId = randomHex(16);
  while (/^0+$/.test(traceId)) traceId = randomHex(16);
  let spanId = randomHex(8);
  while (/^0+$/.test(spanId)) spanId = randomHex(8);
  return `00-${traceId}-${spanId}-01`;
}

export function workflowTraceIdFromTraceparent(
  traceparent: string | null | undefined,
): string | null {
  const match = traceparent
    ?.trim()
    .toLowerCase()
    .match(/^00-([a-f0-9]{32})-[a-f0-9]{16}-[a-f0-9]{2}$/);
  if (!match || /^0+$/.test(match[1])) return null;
  return match[1];
}

export function ensureWorkflowTraceparentHeader(
  headers: Record<string, string>,
): Record<string, string> {
  if (workflowTraceIdFromTraceparent(headers.traceparent)) return headers;
  return { ...headers, traceparent: generateWorkflowTraceparent() };
}

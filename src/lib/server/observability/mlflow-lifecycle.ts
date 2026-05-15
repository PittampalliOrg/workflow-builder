import { env } from "$env/dynamic/private";
import { env as publicEnv } from "$env/dynamic/public";
import { and, eq, ne } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
  agentVersions,
  mlflowLineageLinks,
  sessionEvents,
  sessions,
  workflows,
  workflowExecutions,
  type Agent,
  type AgentVersion,
} from "$lib/server/db/schema";
import {
  compileAgentApplicationState,
  type CompiledAgentApplicationState,
} from "$lib/server/agents/application-state";

type MlflowTag = { key: string; value: string };
type MlflowParam = { key: string; value: string };

type LoggedModelInfo = {
  model_id?: string;
  experiment_id?: string;
  name?: string;
  artifact_uri?: string;
  artifact_location?: string;
  status?: string;
  model_type?: string;
  source_run_id?: string;
  tags?: MlflowTag[];
};

type LoggedModelResponse = {
  model?: {
    info?: LoggedModelInfo;
    data?: { params?: MlflowParam[] };
  };
};

export type MlflowRunContext = {
  experimentId: string;
  experimentName?: string | null;
  traceExperimentId?: string | null;
  traceExperimentName?: string | null;
  runId: string;
  parentRunId?: string | null;
  mlflowSessionId?: string | null;
  publicUrl: string | null;
  activeModelId?: string | null;
  activeModelName?: string | null;
  activeModelUri?: string | null;
  applicationKind?: "agent" | "workflow" | "benchmark" | "unknown";
  applicationId?: string | null;
};

function trackingUri(): string | null {
  const value = (env.MLFLOW_TRACKING_URI ?? "").trim().replace(/\/+$/, "");
  return value || null;
}

function publicMlflowUrl(): string | null {
  const value = (publicEnv.PUBLIC_MLFLOW_URL ?? env.PUBLIC_MLFLOW_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  return value || null;
}

export function mlflowLifecycleEnabled(): boolean {
  const enabled = (env.MLFLOW_ENABLED ?? "").trim().toLowerCase();
  if (
    enabled === "0" ||
    enabled === "false" ||
    enabled === "no" ||
    enabled === "off"
  ) {
    return false;
  }
  return Boolean(trackingUri());
}

function clusterName(): string {
  return (env.WORKFLOW_BUILDER_ENV ?? "unknown").trim() || "unknown";
}

function defaultTraceExperimentName(): string {
  return `workflow-builder/${clusterName()}/traces`;
}

function configuredTraceExperimentName(): string {
  return (
    (env.MLFLOW_TRACE_EXPERIMENT_NAME ?? publicEnv.PUBLIC_MLFLOW_TRACE_EXPERIMENT_NAME ?? "")
      .trim() || defaultTraceExperimentName()
  );
}

async function resolveCanonicalTraceMlflowExperiment(): Promise<{
  experimentId: string;
  experimentName: string;
  publicUrl: string | null;
}> {
  const experimentName = configuredTraceExperimentName();
  const configuredId = (
    env.MLFLOW_TRACE_EXPERIMENT_ID ??
    publicEnv.PUBLIC_MLFLOW_TRACE_EXPERIMENT_ID ??
    ""
  ).trim();
  const experimentId =
    configuredId ||
    (await getOrCreateMlflowExperimentId(experimentName, "traces", [
      tag("workflow_builder.application_kind", "genai_observability"),
    ]));

  await setMlflowExperimentTags(experimentId, [
    tag("workflow_builder.kind", "traces"),
    tag("workflow_builder.application_kind", "genai_observability"),
    tag("workflow_builder.canonical", "true"),
    tag("workflow_builder.env", env.WORKFLOW_BUILDER_ENV ?? "unknown"),
  ]).catch((err) => {
    console.warn(
      `[mlflow] failed to update canonical trace experiment tags ${experimentId}:`,
      err instanceof Error ? err.message : err,
    );
  });

  return {
    experimentId,
    experimentName,
    publicUrl: publicMlflowExperimentUrl(experimentId),
  };
}

export function mlflowArtifactLocationForLifecycleExperiment(
  name: string,
): string {
  return `mlflow-artifacts:/${name
    .split("/")
    .map((part) => part.trim().replace(/[^A-Za-z0-9._-]+/g, "-"))
    .filter(Boolean)
    .join("/")}`;
}

function publicLoggedModelUrl(
  experimentId: string | null | undefined,
  modelId: string | null | undefined,
): string | null {
  const base = publicMlflowUrl();
  if (!base || !experimentId || !modelId) return null;
  return `${base}/#/experiments/${encodeURIComponent(experimentId)}/models/${encodeURIComponent(modelId)}`;
}

function publicMlflowRunUrl(
  experimentId: string | null | undefined,
  runId: string | null | undefined,
): string | null {
  const base = publicMlflowUrl();
  if (!base || !experimentId || !runId) return null;
  return `${base}/#/experiments/${encodeURIComponent(experimentId)}/runs/${encodeURIComponent(runId)}`;
}

function publicMlflowExperimentUrl(
  experimentId: string | null | undefined,
): string | null {
  const base = publicMlflowUrl();
  if (!base || !experimentId) return null;
  return `${base}/#/experiments/${encodeURIComponent(experimentId)}`;
}

async function mlflowRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const base = trackingUri();
  if (!base) throw new Error("MLFLOW_TRACKING_URI is not configured");
  const rawTimeoutMs = Number(env.MLFLOW_REQUEST_TIMEOUT_MS ?? 3000);
  const timeoutMs = Number.isFinite(rawTimeoutMs)
    ? Math.max(500, rawTimeoutMs)
    : 3000;
  const res = await fetch(`${base}${path}`, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      ...(init.method && init.method !== "GET"
        ? { "Content-Type": "application/json" }
        : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `MLflow ${path} returned ${res.status}: ${text.slice(0, 500)}`,
    );
  }
  return (await res.json().catch(() => ({}))) as T;
}

export async function resolveAgentApplicationMlflowExperiment(params: {
  agent: Pick<Agent, "id" | "slug" | "name" | "projectId">;
}): Promise<{ experimentId: string; experimentName: string; publicUrl: string | null }> {
  if (!mlflowLifecycleEnabled()) {
    throw new Error("MLflow lifecycle is not enabled");
  }
  void params;
  return resolveCanonicalTraceMlflowExperiment();
}

function normalizeMlflowTraceId(value: string | null | undefined): string | null {
  const raw = value?.trim().toLowerCase() ?? "";
  if (!raw) return null;
  const normalized = raw.startsWith("tr-") ? raw.slice(3) : raw;
  if (!/^[a-f0-9]{32}$/.test(normalized) || /^0+$/.test(normalized)) return null;
  return `tr-${normalized}`;
}

function cleanRecord(value: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!key || raw == null) continue;
    const stringValue = String(raw).trim();
    if (stringValue) out[key] = stringValue.slice(0, 5000);
  }
  return out;
}

export async function precreateMlflowTrace(params: {
  traceId: string | null | undefined;
  experimentId: string | null | undefined;
  requestTime?: Date | null;
  name?: string | null;
  metadata?: Record<string, unknown>;
  tags?: Record<string, unknown>;
}): Promise<string | null> {
  if (!mlflowLifecycleEnabled()) return null;
  const traceId = normalizeMlflowTraceId(params.traceId);
  const experimentId = params.experimentId?.trim();
  if (!traceId || !experimentId) {
    throw new Error("MLflow trace precreate requires traceId and experimentId");
  }
  const metadata = cleanRecord(params.metadata ?? {});
  const tags = cleanRecord({
    ...(params.name ? { "mlflow.traceName": params.name } : {}),
    ...(params.tags ?? {}),
  });
  await mlflowRequest("/api/3.0/mlflow/traces", {
    method: "POST",
    body: JSON.stringify({
      trace: {
        traceInfo: {
          traceId,
          traceLocation: {
            type: "MLFLOW_EXPERIMENT",
            mlflowExperiment: { experimentId },
          },
          requestTime: (params.requestTime ?? new Date()).toISOString(),
          state: "IN_PROGRESS",
          traceMetadata: metadata,
          tags,
        },
      },
    }),
  });
  return traceId;
}

export async function safePrecreateMlflowTrace(
  params: Parameters<typeof precreateMlflowTrace>[0],
): Promise<string | null> {
  try {
    return await precreateMlflowTrace(params);
  } catch (err) {
    console.warn(
      "[mlflow] failed to pre-create trace:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

async function getOrCreateMlflowExperimentId(
  name: string,
  kind: string,
  extraTags: MlflowTag[] = [],
): Promise<string> {
  const qs = new URLSearchParams({ experiment_name: name });
  try {
    const found = await mlflowRequest<{
      experiment?: { experiment_id?: string };
    }>(`/api/2.0/mlflow/experiments/get-by-name?${qs.toString()}`, {
      method: "GET",
    });
    if (found.experiment?.experiment_id) return found.experiment.experiment_id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("RESOURCE_DOES_NOT_EXIST") && !msg.includes("404"))
      throw err;
  }

  const created = await mlflowRequest<{ experiment_id?: string }>(
    "/api/2.0/mlflow/experiments/create",
    {
      method: "POST",
      body: JSON.stringify({
        name,
        artifact_location: mlflowArtifactLocationForLifecycleExperiment(name),
        tags: [
          { key: "workflow_builder.kind", value: kind },
          {
            key: "workflow_builder.env",
            value: env.WORKFLOW_BUILDER_ENV ?? "unknown",
          },
          ...extraTags,
        ],
      }),
    },
  ).catch(async (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      !msg.includes("RESOURCE_ALREADY_EXISTS") &&
      !msg.includes("already exists")
    ) {
      throw err;
    }
    const retry = await mlflowRequest<{
      experiment?: { experiment_id?: string };
    }>(`/api/2.0/mlflow/experiments/get-by-name?${qs.toString()}`, {
      method: "GET",
    });
    return { experiment_id: retry.experiment?.experiment_id };
  });
  if (!created.experiment_id)
    throw new Error("MLflow lifecycle experiment create returned no id");
  return created.experiment_id;
}

async function setMlflowExperimentTags(
  experimentId: string,
  tags: MlflowTag[],
): Promise<void> {
  await Promise.all(
    tags
      .filter((item) => item.key && item.value !== "")
      .map((item) =>
        mlflowRequest("/api/2.0/mlflow/experiments/set-experiment-tag", {
          method: "POST",
          body: JSON.stringify({
            experiment_id: experimentId,
            key: item.key,
            value: item.value,
          }),
        }),
      ),
  );
}

async function setMlflowRunTags(runId: string, tags: MlflowTag[]): Promise<void> {
  await Promise.all(
    tags
      .filter((item) => item.key && item.value !== "")
      .map((item) =>
        mlflowRequest("/api/2.0/mlflow/runs/set-tag", {
          method: "POST",
          body: JSON.stringify({
            run_id: runId,
            key: item.key,
            value: item.value,
          }),
        }),
      ),
  );
}

function tag(key: string, value: unknown): MlflowTag {
  return { key, value: value == null ? "" : String(value).slice(0, 5000) };
}

function param(key: string, value: unknown): MlflowParam {
  return { key, value: value == null ? "" : String(value).slice(0, 5000) };
}

async function resolveWorkflowExperiment(params: {
  workflowId: string;
  workflowName?: string | null;
  projectId?: string | null;
}): Promise<{ experimentId: string; experimentName: string }> {
  const [row] = await db
    .select({
      id: workflows.id,
      name: workflows.name,
      projectId: workflows.projectId,
    })
    .from(workflows)
    .where(eq(workflows.id, params.workflowId))
    .limit(1);
  const workflowName = row?.name ?? params.workflowName ?? params.workflowId;
  const canonical = await resolveCanonicalTraceMlflowExperiment();

  await db
    .update(workflows)
    .set({
      mlflowExperimentId: canonical.experimentId,
      mlflowExperimentName: canonical.experimentName,
    })
    .where(eq(workflows.id, params.workflowId));

  await db
    .delete(mlflowLineageLinks)
    .where(
      and(
        eq(mlflowLineageLinks.entityType, "workflow"),
        eq(mlflowLineageLinks.entityId, params.workflowId),
        eq(mlflowLineageLinks.mlflowEntityType, "experiment"),
        ne(mlflowLineageLinks.mlflowExperimentId, canonical.experimentId),
      ),
    );

  await db
    .insert(mlflowLineageLinks)
    .values({
      sourceKey: `workflow:${params.workflowId}:experiment:${canonical.experimentId}`,
      entityType: "workflow",
      entityId: params.workflowId,
      projectId: row?.projectId ?? params.projectId ?? null,
      mlflowEntityType: "experiment",
      mlflowExperimentId: canonical.experimentId,
      mlflowPublicUrl: canonical.publicUrl,
      tags: {
        workflowName,
        experimentName: canonical.experimentName,
      },
      metadata: {},
    })
    .onConflictDoUpdate({
      target: mlflowLineageLinks.sourceKey,
      set: {
        projectId: row?.projectId ?? params.projectId ?? null,
        mlflowExperimentId: canonical.experimentId,
        mlflowPublicUrl: canonical.publicUrl,
        tags: {
          workflowName,
          experimentName: canonical.experimentName,
        },
        updatedAt: new Date(),
      },
    });

  return {
    experimentId: canonical.experimentId,
    experimentName: canonical.experimentName,
  };
}

async function createMlflowRun(params: {
  experimentId: string;
  runName: string;
  userId?: string | null;
  tags: MlflowTag[];
}): Promise<string> {
  const created = await mlflowRequest<{
    run?: { info?: { run_id?: string; run_uuid?: string } };
  }>("/api/2.0/mlflow/runs/create", {
    method: "POST",
    body: JSON.stringify({
      experiment_id: params.experimentId,
      run_name: params.runName,
      user_id: params.userId ?? undefined,
      start_time: Date.now(),
      tags: params.tags,
    }),
  });
  const runId = created.run?.info?.run_id ?? created.run?.info?.run_uuid;
  if (!runId) throw new Error("MLflow run create returned no run_id");
  return runId;
}

async function getMlflowRunArtifactUri(runId: string): Promise<string | null> {
  const payload = await mlflowRequest<{
    run?: { info?: { artifact_uri?: string; artifact_location?: string } };
  }>(`/api/2.0/mlflow/runs/get?run_id=${encodeURIComponent(runId)}`);
  return payload.run?.info?.artifact_uri ?? payload.run?.info?.artifact_location ?? null;
}

async function getMlflowRunExperimentId(runId: string): Promise<string | null> {
  const payload = await mlflowRequest<{
    run?: { info?: { experiment_id?: string } };
  }>(`/api/2.0/mlflow/runs/get?run_id=${encodeURIComponent(runId)}`);
  return payload.run?.info?.experiment_id ?? null;
}

async function logRunJsonArtifact(params: {
  runId: string;
  artifactPath: string;
  value: unknown;
}): Promise<void> {
  const artifactUri = await getMlflowRunArtifactUri(params.runId);
  const artifactRoot = artifactRootPath(artifactUri);
  const path = artifactRoot
    ? `${artifactRoot}/${params.artifactPath}`
    : `${params.runId}/artifacts/${params.artifactPath}`;
  const encodedPath = encodeArtifactPath(path);
  await mlflowRequest(`/api/2.0/mlflow-artifacts/artifacts/${encodedPath}`, {
    method: "PUT",
    body: `${JSON.stringify(params.value, null, 2)}\n`,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function modelIdFromMlflowUri(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  const match = text.match(/^models:\/([^/]+)$/);
  return match?.[1] ?? null;
}

function escapeMlflowFilterValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function traceIdFromSearchItem(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const obj = item as Record<string, unknown>;
  const info =
    (obj.trace_info as Record<string, unknown> | undefined) ??
    (obj.info as Record<string, unknown> | undefined) ??
    obj;
  const raw = info.trace_id ?? info.traceId ?? obj.trace_id ?? obj.traceId;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function traceStateFromSearchItem(item: unknown): "OK" | "ERROR" | null {
  if (!item || typeof item !== "object") return null;
  const obj = item as Record<string, unknown>;
  const info =
    (obj.trace_info as Record<string, unknown> | undefined) ??
    (obj.info as Record<string, unknown> | undefined) ??
    obj;
  const raw = info.state ?? info.status;
  if (raw === "OK" || raw === "ERROR") return raw;
  return null;
}

function traceEndTimestampMsFromSearchItem(item: unknown): number {
  if (!item || typeof item !== "object") return Date.now();
  const obj = item as Record<string, unknown>;
  const info =
    (obj.trace_info as Record<string, unknown> | undefined) ??
    (obj.info as Record<string, unknown> | undefined) ??
    obj;
  const startMs =
    typeof info.timestamp_ms === "number"
      ? info.timestamp_ms
      : typeof info.timestampMs === "number"
        ? info.timestampMs
        : typeof info.request_time === "string"
          ? Date.parse(info.request_time)
          : typeof info.requestTime === "string"
            ? Date.parse(info.requestTime)
            : NaN;
  const durationMs =
    typeof info.execution_time_ms === "number"
      ? info.execution_time_ms
      : typeof info.executionTimeMs === "number"
        ? info.executionTimeMs
        : NaN;
  if (Number.isFinite(startMs) && Number.isFinite(durationMs)) {
    return Math.round(startMs + durationMs);
  }
  const durationText =
    typeof info.execution_duration === "string"
      ? info.execution_duration
      : typeof info.executionDuration === "string"
        ? info.executionDuration
        : "";
  const seconds = Number(durationText.replace(/s$/, ""));
  if (Number.isFinite(startMs) && Number.isFinite(seconds)) {
    return Math.round(startMs + seconds * 1000);
  }
  return Date.now();
}

function publicMlflowTraceUrl(
  experimentId: string | null | undefined,
  traceId: string | null | undefined,
): string | null {
  const base = publicMlflowUrl();
  if (!base || !experimentId || !traceId) return null;
  const query = new URLSearchParams({ selectedEvaluationId: traceId });
  return `${base}/#/experiments/${encodeURIComponent(experimentId)}/traces?${query.toString()}`;
}

const TRACE_ID_KEYS = new Set([
  "traceid",
  "trace_id",
  "mlflowtraceid",
  "mlflow_trace_id",
]);

function collectTraceIdsFromValue(
  value: unknown,
  out: Set<string>,
  depth = 0,
): void {
  if (depth > 6 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectTraceIdsFromValue(item, out, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.replace(/[^a-zA-Z0-9_]/g, "").toLowerCase();
    if (TRACE_ID_KEYS.has(normalizedKey) && typeof raw === "string") {
      const traceId = normalizeMlflowTraceId(raw);
      if (traceId) out.add(traceId);
      continue;
    }
    collectTraceIdsFromValue(raw, out, depth + 1);
  }
}

async function sessionEventTraceIds(sessionId: string): Promise<string[]> {
  const rows = await db
    .select({ data: sessionEvents.data })
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionId, sessionId));
  const ids = new Set<string>();
  for (const row of rows) collectTraceIdsFromValue(row.data, ids);
  return Array.from(ids);
}

function sessionTraceLookupValues(sessionId: string): string[] {
  const raw = sessionId.trim();
  const lower = raw.toLowerCase();
  const k8sLabel = lower
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/_/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "")
    .slice(0, 63);
  return Array.from(new Set([raw, lower, k8sLabel].filter(Boolean)));
}

export async function patchMlflowTracesForSession(params: {
  sessionId: string;
  experimentId: string | null | undefined;
  runId: string | null | undefined;
  modelId: string | null | undefined;
  status?: "OK" | "ERROR";
  endTime?: Date | number | null;
  traceIds?: string[];
}): Promise<number> {
  if (!mlflowLifecycleEnabled()) return 0;
  const sessionId = params.sessionId.trim();
  const experimentId = params.experimentId?.trim();
  if (!sessionId || !experimentId) return 0;

  const matches = new Map<string, unknown>();
  for (const rawTraceId of params.traceIds ?? []) {
    const traceId = normalizeMlflowTraceId(rawTraceId);
    if (traceId) matches.set(traceId, null);
  }
  for (const value of sessionTraceLookupValues(sessionId)) {
    let pageToken: string | undefined;
    const filter = `metadata.\`mlflow.trace.session\` LIKE '%${escapeMlflowFilterValue(value)}%'`;
    for (let page = 0; page < 20; page += 1) {
      const payload = await mlflowRequest<{
        traces?: unknown[];
        next_page_token?: string;
      }>("/api/3.0/mlflow/traces/search", {
        method: "POST",
        body: JSON.stringify({
          locations: [
            {
              type: "MLFLOW_EXPERIMENT",
              mlflow_experiment: { experiment_id: experimentId },
            },
          ],
          filter,
          max_results: 250,
          order_by: ["timestamp_ms DESC"],
          ...(pageToken ? { page_token: pageToken } : {}),
        }),
      });
      for (const item of payload.traces ?? []) {
        const traceId = normalizeMlflowTraceId(traceIdFromSearchItem(item));
        if (traceId) matches.set(traceId, item);
      }
      pageToken = payload.next_page_token;
      if (!pageToken) break;
    }
  }

  const endTime =
    params.endTime instanceof Date
      ? params.endTime.getTime()
      : typeof params.endTime === "number"
        ? params.endTime
        : null;
  let patched = 0;
  for (const [traceId, item] of matches) {
    await mlflowRequest(`/api/2.0/mlflow/traces/${encodeURIComponent(traceId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        timestamp_ms: endTime ?? traceEndTimestampMsFromSearchItem(item),
        status: traceStateFromSearchItem(item) ?? params.status ?? "OK",
        request_metadata: [
          { key: "mlflow.trace.session", value: sessionId },
          ...(params.runId ? [{ key: "mlflow.sourceRun", value: params.runId }] : []),
          ...(params.modelId ? [{ key: "mlflow.modelId", value: params.modelId }] : []),
        ],
        tags: [
          { key: "session.id", value: sessionId },
          { key: "agent.session.id", value: sessionId },
          { key: "workflow_builder.session_id", value: sessionId },
          { key: "workflow_builder.mlflow_session_id", value: sessionId },
          ...(params.runId ? [{ key: "mlflow.run_id", value: params.runId }] : []),
          ...(params.modelId ? [{ key: "mlflow.modelId", value: params.modelId }] : []),
        ],
      }),
    });
    patched += 1;
  }
  return patched;
}

async function upsertInteractiveSessionTraceLineage(params: {
  localSessionId: string;
  mlflowSessionId: string;
  experimentId: string;
  runId: string | null | undefined;
  modelId: string | null | undefined;
  projectId: string | null | undefined;
  traceIds: string[];
}): Promise<void> {
  const uniqueTraceIds = Array.from(
    new Set(params.traceIds.map((id) => normalizeMlflowTraceId(id)).filter(Boolean)),
  ) as string[];
  for (const traceId of uniqueTraceIds) {
    await db
      .insert(mlflowLineageLinks)
      .values({
        sourceKey: `session:${params.localSessionId}:trace:${traceId}`,
        entityType: "session",
        entityId: params.localSessionId,
        projectId: params.projectId ?? null,
        mlflowEntityType: "trace",
        mlflowExperimentId: params.experimentId,
        mlflowRunId: params.runId ?? null,
        mlflowSessionId: params.mlflowSessionId,
        mlflowTraceId: traceId,
        mlflowLoggedModelId: params.modelId ?? null,
        mlflowModelVersion: params.modelId ?? null,
        mlflowPublicUrl: publicMlflowTraceUrl(params.experimentId, traceId),
        tags: {
          source: "interactive_session_trace",
          mlflowSessionId: params.mlflowSessionId,
        },
        metadata: {
          patchedFromSessionEvents: true,
        },
      })
      .onConflictDoUpdate({
        target: mlflowLineageLinks.sourceKey,
        set: {
          mlflowExperimentId: params.experimentId,
          mlflowRunId: params.runId ?? null,
          mlflowSessionId: params.mlflowSessionId,
          mlflowTraceId: traceId,
          mlflowLoggedModelId: params.modelId ?? null,
          mlflowModelVersion: params.modelId ?? null,
          mlflowPublicUrl: publicMlflowTraceUrl(params.experimentId, traceId),
          updatedAt: new Date(),
        },
      });
  }
}

export async function patchInteractiveSessionMlflowTraces(params: {
  sessionId: string;
  status?: "OK" | "ERROR";
  endTime?: Date | number | null;
}): Promise<number> {
  if (!mlflowLifecycleEnabled()) return 0;
  const sessionId = params.sessionId.trim();
  if (!sessionId) return 0;
  const [session] = await db
    .select({
      mlflowExperimentId: sessions.mlflowExperimentId,
      mlflowRunId: sessions.mlflowRunId,
      mlflowSessionId: sessions.mlflowSessionId,
      projectId: sessions.projectId,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!session) return 0;
  const experimentId =
    session.mlflowExperimentId?.trim() ||
    (await resolveCanonicalTraceMlflowExperiment()).experimentId;
  const links = await db
    .select({
      mlflowLoggedModelId: mlflowLineageLinks.mlflowLoggedModelId,
      mlflowModelVersion: mlflowLineageLinks.mlflowModelVersion,
    })
    .from(mlflowLineageLinks)
    .where(
      and(
        eq(mlflowLineageLinks.entityType, "session"),
        eq(mlflowLineageLinks.entityId, sessionId),
      ),
    );
  const modelLink =
    links.find((link) => link.mlflowLoggedModelId || link.mlflowModelVersion) ??
    null;
  const mlflowSessionId = session.mlflowSessionId?.trim() || sessionId;
  const traceIds = await sessionEventTraceIds(sessionId);
  const patched = await patchMlflowTracesForSession({
    sessionId: mlflowSessionId,
    experimentId,
    runId: session.mlflowRunId,
    modelId: modelLink?.mlflowLoggedModelId ?? modelLink?.mlflowModelVersion ?? null,
    status: params.status,
    endTime: params.endTime,
    traceIds,
  });
  if (traceIds.length > 0) {
    await upsertInteractiveSessionTraceLineage({
      localSessionId: sessionId,
      mlflowSessionId,
      experimentId,
      runId: session.mlflowRunId,
      modelId: modelLink?.mlflowLoggedModelId ?? modelLink?.mlflowModelVersion ?? null,
      projectId: session.projectId,
      traceIds,
    });
  }
  return patched;
}

export async function safePatchInteractiveSessionMlflowTraces(
  params: Parameters<typeof patchInteractiveSessionMlflowTraces>[0],
): Promise<number> {
  try {
    return await patchInteractiveSessionMlflowTraces(params);
  } catch (err) {
    console.warn(
      `[mlflow] failed to patch session traces ${params.sessionId}:`,
      err instanceof Error ? err.message : err,
    );
    return 0;
  }
}

async function findAgentApplicationStateLoggedModel(
  experimentId: string,
  stateDigest: string,
  agent: Pick<Agent, "id" | "slug">,
): Promise<LoggedModelResponse["model"] | null> {
  const payload = await mlflowRequest<{
    models?: NonNullable<LoggedModelResponse["model"]>[];
  }>("/api/2.0/mlflow/logged-models/search", {
    method: "POST",
    body: JSON.stringify({
      experiment_ids: [experimentId],
      filter: `tags.\`workflow_builder.agent_state_digest\` = '${escapeMlflowFilterValue(stateDigest)}'`,
      max_results: 50,
      order_by: [{ field_name: "creation_time", ascending: false }],
    }),
  });
  return (
    payload.models?.find((model) => {
      const tags = model.info?.tags ?? [];
      const agentId = tags.find((item) => item.key === "workflow_builder.agent_id")?.value;
      const agentSlug = tags.find((item) => item.key === "workflow_builder.agent_slug")?.value;
      return agentId === agent.id || agentSlug === agent.slug;
    }) ?? null
  );
}

async function createAgentVersionLoggedModel(params: {
  experimentId: string;
  agent: Agent;
  version: AgentVersion;
  state: CompiledAgentApplicationState;
}): Promise<NonNullable<LoggedModelResponse["model"]>> {
  const modelName = safeLoggedModelName(
    `workflow-builder_${params.agent.slug}_${params.state.stateDigest.slice(0, 12)}`,
  );
  const config = params.version.config as Record<string, unknown>;
  const toolCount =
    params.state.manifest.tools.builtinTools.length +
    params.state.manifest.tools.toolNames.length;
  const mcpCount = params.state.manifest.tools.mcpServers.length;
  const promptManifestCount =
    params.state.manifest.prompts.presetManifest?.length ?? 0;
  const promptRefCount =
    (params.state.manifest.prompts.staticPresetRefs?.length ?? 0) +
    (params.state.manifest.prompts.dynamicPresetRefs?.length ?? 0);
  const promptCount = promptManifestCount || promptRefCount;
  const created = await mlflowRequest<LoggedModelResponse>(
    "/api/2.0/mlflow/logged-models",
    {
      method: "POST",
      body: JSON.stringify({
        experiment_id: params.experimentId,
        name: modelName,
        model_type: "agent",
        params: [
          param("agent_id", params.agent.id),
          param("agent_slug", params.agent.slug),
          param("agent_version", params.version.version),
          param("agent_version_id", params.version.id),
          param("agent_state_digest", params.state.stateDigest),
          param("config_hash", params.version.configHash),
          param("model_spec", config.modelSpec),
          param("model_provider", params.state.manifest.model.provider),
          param("runtime", params.agent.runtime),
          param("runtime_class", params.state.manifest.runtime.route.runtimeClass),
          param("runtime_app_id", params.state.manifest.agent.runtimeAppId),
          param("tool_count", toolCount),
          param("mcp_count", mcpCount),
          param("prompt_count", promptCount),
        ],
        tags: [
          tag("workflow_builder.entity_type", "agent_application_state"),
          tag("workflow_builder.agent_id", params.agent.id),
          tag("workflow_builder.agent_slug", params.agent.slug),
          tag("workflow_builder.agent_version_id", params.version.id),
          tag("workflow_builder.agent_version", params.version.version),
          tag("workflow_builder.agent_state_digest", params.state.stateDigest),
          tag("workflow_builder.project_id", params.agent.projectId),
          tag("workflow_builder.env", env.WORKFLOW_BUILDER_ENV ?? "unknown"),
          tag("agent.name", params.agent.name),
          tag("agent.app_id", params.state.manifest.agent.runtimeAppId),
          tag("agent.runtime_class", params.state.manifest.runtime.route.runtimeClass),
        ],
      }),
    },
  );
  if (!created.model?.info?.model_id) {
    throw new Error("MLflow logged model create returned no model id");
  }
  await logAgentApplicationStateArtifacts({
    modelId: created.model.info.model_id,
    artifactUri: created.model.info.artifact_uri ?? created.model.info.artifact_location ?? null,
    state: params.state,
  });
  await mlflowRequest<LoggedModelResponse>(
    `/api/2.0/mlflow/logged-models/${encodeURIComponent(created.model.info.model_id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        model_id: created.model.info.model_id,
        status: "LOGGED_MODEL_READY",
      }),
    },
  ).catch((err) => {
    console.warn(
      "[mlflow] failed to finalize agent logged model:",
      err instanceof Error ? err.message : err,
    );
    return created;
  });
  return created.model;
}

async function logAgentApplicationStateArtifacts(params: {
  modelId: string;
  artifactUri: string | null;
  state: CompiledAgentApplicationState;
}): Promise<void> {
  await Promise.all([
    logLoggedModelJsonArtifact({
      modelId: params.modelId,
      artifactUri: params.artifactUri,
      artifactPath: "application-state.json",
      value: params.state.manifest,
    }),
    logLoggedModelJsonArtifact({
      modelId: params.modelId,
      artifactUri: params.artifactUri,
      artifactPath: "dapr-agent-metadata.json",
      value: params.state.daprMetadata,
    }),
    logLoggedModelJsonArtifact({
      modelId: params.modelId,
      artifactUri: params.artifactUri,
      artifactPath: "prompt-manifest.json",
      value: params.state.promptManifest,
    }),
    logLoggedModelJsonArtifact({
      modelId: params.modelId,
      artifactUri: params.artifactUri,
      artifactPath: "tool-mcp-manifest.json",
      value: params.state.toolManifest,
    }),
    logLoggedModelJsonArtifact({
      modelId: params.modelId,
      artifactUri: params.artifactUri,
      artifactPath: "source-manifest.json",
      value: params.state.sourceManifest,
    }),
  ]);
}

async function logLoggedModelJsonArtifact(params: {
  modelId: string;
  artifactUri: string | null;
  artifactPath: string;
  value: unknown;
}): Promise<void> {
  const artifactRoot = artifactRootPath(params.artifactUri);
  const path = artifactRoot
    ? `${artifactRoot}/${params.artifactPath}`
    : `logged_models/${params.modelId}/${params.artifactPath}`;
  const encodedPath = encodeArtifactPath(path);
  await mlflowRequest(
    `/api/2.0/mlflow-artifacts/artifacts/${encodedPath}`,
    {
      method: "PUT",
      body: `${JSON.stringify(params.value, null, 2)}\n`,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
    },
  );
}

function artifactRootPath(uri: string | null): string | null {
  if (!uri) return null;
  const trimmed = uri.trim();
  if (trimmed.startsWith("mlflow-artifacts:/")) {
    return trimmed.replace(/^mlflow-artifacts:\/*/, "").replace(/^\/+|\/+$/g, "");
  }
  const marker = "/api/2.0/mlflow-artifacts/artifacts/";
  const idx = trimmed.indexOf(marker);
  if (idx >= 0) {
    return trimmed.slice(idx + marker.length).replace(/^\/+|\/+$/g, "");
  }
  return null;
}

function encodeArtifactPath(path: string): string {
  return path
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function safeLoggedModelName(value: string): string {
  return (
    value
      .trim()
      .replace(/[/:.%'"]/g, "_")
      .replace(/[^A-Za-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 240) || "workflow-builder-agent"
  );
}

export async function registerAgentVersionInMlflow(params: {
  agent: Agent;
  version: AgentVersion;
}): Promise<{
  modelId: string;
  modelName: string | null;
  modelUri: string;
} | null> {
  if (!mlflowLifecycleEnabled()) return null;
  const state = compileAgentApplicationState(params);
  const { experimentId, experimentName } =
    await resolveAgentApplicationMlflowExperiment({ agent: params.agent });
  const existing =
    (await findAgentApplicationStateLoggedModel(
      experimentId,
      state.stateDigest,
      params.agent,
    )) ??
    (await createAgentVersionLoggedModel({
      experimentId,
      agent: params.agent,
      version: params.version,
      state,
    }));
  const info = existing.info;
  const modelId = info?.model_id;
  if (!modelId) throw new Error("MLflow logged model response has no model_id");
  const modelUri = `models:/${modelId}`;
  const modelName = info?.name ?? null;
  const modelUrl = publicLoggedModelUrl(experimentId, modelId);

  await db.transaction(async (tx) => {
    await tx
      .update(agentVersions)
      .set({
        applicationStateDigest: state.stateDigest,
        mlflowUri: modelUri,
        mlflowModelName: modelName,
        mlflowModelVersion: modelId,
      })
      .where(eq(agentVersions.id, params.version.id));

    await tx
      .delete(mlflowLineageLinks)
      .where(
        and(
          eq(mlflowLineageLinks.entityType, "agent_version"),
          eq(mlflowLineageLinks.entityId, params.version.id),
          eq(mlflowLineageLinks.mlflowEntityType, "logged_model"),
          ne(mlflowLineageLinks.mlflowLoggedModelId, modelId),
        ),
      );

    await tx
      .insert(mlflowLineageLinks)
      .values({
        sourceKey: `agent_version:${params.version.id}:logged_model:${modelId}`,
        entityType: "agent_version",
        entityId: params.version.id,
        entityVersion: String(params.version.version),
        projectId: params.agent.projectId ?? null,
        mlflowEntityType: "logged_model",
        mlflowExperimentId: experimentId,
        mlflowLoggedModelId: modelId,
        mlflowLoggedModelName: modelName,
        mlflowLoggedModelUri: modelUri,
        mlflowModelVersion: modelId,
        mlflowPublicUrl: modelUrl,
        tags: {
          agentId: params.agent.id,
          agentSlug: params.agent.slug,
          configHash: params.version.configHash,
          applicationStateDigest: state.stateDigest,
          experimentName,
        },
        metadata: {
          artifactUri: info?.artifact_uri ?? null,
          artifactLocation: info?.artifact_location ?? null,
          status: info?.status ?? null,
          applicationState: state.manifest,
        },
      })
      .onConflictDoUpdate({
        target: mlflowLineageLinks.sourceKey,
        set: {
          mlflowExperimentId: experimentId,
          mlflowLoggedModelName: modelName,
          mlflowLoggedModelUri: modelUri,
          mlflowModelVersion: modelId,
          mlflowPublicUrl: modelUrl,
        tags: {
          agentId: params.agent.id,
          agentSlug: params.agent.slug,
          configHash: params.version.configHash,
          applicationStateDigest: state.stateDigest,
          experimentName,
        },
          updatedAt: new Date(),
        },
      });
  });

  return { modelId, modelName, modelUri };
}

export async function safeRegisterAgentVersionInMlflow(params: {
  agent: Agent;
  version: AgentVersion;
}): Promise<void> {
  try {
    await registerAgentVersionInMlflow(params);
  } catch (err) {
    console.warn(
      `[mlflow] failed to register agent version ${params.agent.id}@${params.version.version}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

export async function createWorkflowExecutionMlflowRun(params: {
  executionId: string;
  workflowId: string;
  workflowName?: string | null;
  projectId?: string | null;
  userId?: string | null;
}): Promise<MlflowRunContext | null> {
  if (!mlflowLifecycleEnabled()) return null;
  const { experimentId, experimentName } = await resolveWorkflowExperiment({
    workflowId: params.workflowId,
    workflowName: params.workflowName,
    projectId: params.projectId,
  });
  const traceExperimentId = experimentId;
  const traceExperimentName = experimentName;
  const runName = `workflow/${params.workflowName || params.workflowId}/${params.executionId.slice(0, 12)}`;
  const runId = await createMlflowRun({
    experimentId,
    runName,
    userId: params.userId ?? null,
    tags: [
      tag("workflow_builder.kind", "workflow_execution"),
      tag("workflow_builder.workflow_id", params.workflowId),
      tag("workflow_builder.workflow_name", params.workflowName),
      tag("workflow_builder.workflow_execution_id", params.executionId),
      tag("workflow_builder.trace_group_id", params.executionId),
      tag("workflow.execution.id", params.executionId),
      tag("workflow_builder.project_id", params.projectId),
      tag("workflow_builder.env", env.WORKFLOW_BUILDER_ENV ?? "unknown"),
      tag("workflow_builder.trace_experiment_id", traceExperimentId),
    ],
  });
  const publicUrl = publicMlflowRunUrl(experimentId, runId);

  await db.transaction(async (tx) => {
    await tx
      .update(workflowExecutions)
      .set({
        mlflowExperimentId: experimentId,
        mlflowRunId: runId,
      })
      .where(eq(workflowExecutions.id, params.executionId));

    await tx
      .insert(mlflowLineageLinks)
      .values({
        sourceKey: `workflow_execution:${params.executionId}:run:${runId}`,
        entityType: "workflow_execution",
        entityId: params.executionId,
        projectId: params.projectId ?? null,
        mlflowEntityType: "run",
        mlflowExperimentId: experimentId,
        mlflowRunId: runId,
        mlflowPublicUrl: publicUrl,
        tags: {
          workflowId: params.workflowId,
          workflowName: params.workflowName ?? null,
          source: "parent_run",
          traceGroupId: params.executionId,
        },
        metadata: {},
      })
      .onConflictDoUpdate({
        target: mlflowLineageLinks.sourceKey,
        set: {
          mlflowExperimentId: experimentId,
          mlflowRunId: runId,
          mlflowPublicUrl: publicUrl,
          updatedAt: new Date(),
        },
      });
  });

  return {
    experimentId,
    experimentName,
    traceExperimentId,
    traceExperimentName,
    runId,
    parentRunId: null,
    publicUrl,
    applicationKind: "workflow",
    applicationId: params.workflowId,
  };
}

export async function safeCreateWorkflowExecutionMlflowRun(
  params: Parameters<typeof createWorkflowExecutionMlflowRun>[0],
): Promise<MlflowRunContext | null> {
  try {
    return await createWorkflowExecutionMlflowRun(params);
  } catch (err) {
    console.warn(
      `[mlflow] failed to create workflow execution run ${params.executionId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export async function createInteractiveSessionMlflowRun(params: {
  sessionId: string;
  title?: string | null;
  projectId?: string | null;
  userId?: string | null;
  agentId: string;
  agentName?: string | null;
  agentSlug?: string | null;
  agentVersion?: number | null;
  agentAppId?: string | null;
  activeModelId?: string | null;
  activeModelName?: string | null;
  activeModelUri?: string | null;
  existingRunId?: string | null;
}): Promise<MlflowRunContext | null> {
  if (!mlflowLifecycleEnabled()) return null;
  const agentSlug = params.agentSlug?.trim() || params.agentId;
  const {
    experimentId: agentExperimentId,
    experimentName: agentExperimentName,
  } = await resolveAgentApplicationMlflowExperiment({
    agent: {
      id: params.agentId,
      slug: agentSlug,
      name: params.agentName ?? agentSlug,
      projectId: params.projectId ?? null,
    },
  });
  const {
    experimentId: traceExperimentId,
    experimentName: traceExperimentName,
  } = await resolveCanonicalTraceMlflowExperiment();
  const runExperimentId = traceExperimentId;
  const runExperimentName = traceExperimentName ?? agentExperimentName;
  const mlflowSessionId = params.sessionId;
  const activeModelId =
    params.activeModelId ?? modelIdFromMlflowUri(params.activeModelUri);
  const runTags = [
    tag("workflow_builder.kind", "interactive_session"),
    tag("workflow_builder.session_id", params.sessionId),
    tag("workflow_builder.mlflow_session_id", mlflowSessionId),
    tag("session.id", mlflowSessionId),
    tag("agent.session.id", params.sessionId),
    tag("workflow_builder.agent_id", params.agentId),
    tag("workflow_builder.agent_version", params.agentVersion),
    tag("workflow_builder.agent_slug", agentSlug),
    tag("workflow_builder.agent_app_id", params.agentAppId),
    tag("workflow_builder.agent_mlflow_uri", params.activeModelUri),
    tag("workflow_builder.project_id", params.projectId),
    tag("workflow_builder.env", env.WORKFLOW_BUILDER_ENV ?? "unknown"),
    tag("workflow_builder.trace_experiment_id", traceExperimentId),
    tag("mlflow.modelId", activeModelId),
    tag("mlflow.model.uri", params.activeModelUri),
  ];
  const existingRunId = params.existingRunId?.trim();
  const existingRunExperimentId = existingRunId
    ? await getMlflowRunExperimentId(existingRunId).catch(() => null)
    : null;
  const runId =
    existingRunId && existingRunExperimentId === runExperimentId
      ? existingRunId
      : await createMlflowRun({
          experimentId: runExperimentId,
          runName: `session/${agentSlug}/${params.sessionId.slice(0, 12)}`,
          userId: params.userId ?? null,
          tags: runTags,
        });
  if (existingRunId && existingRunExperimentId === runExperimentId) {
    await setMlflowRunTags(runId, runTags);
  }
  const publicUrl = publicMlflowRunUrl(runExperimentId, runId);

  await db.transaction(async (tx) => {
    await tx
      .update(sessions)
      .set({
        mlflowExperimentId: runExperimentId,
        mlflowRunId: runId,
        mlflowParentRunId: null,
        mlflowSessionId,
      })
      .where(eq(sessions.id, params.sessionId));

    await tx
      .delete(mlflowLineageLinks)
      .where(
        and(
          eq(mlflowLineageLinks.entityType, "session"),
          eq(mlflowLineageLinks.entityId, params.sessionId),
          eq(mlflowLineageLinks.mlflowEntityType, "run"),
          ne(mlflowLineageLinks.mlflowRunId, runId),
        ),
      );

    await tx
      .insert(mlflowLineageLinks)
      .values({
        sourceKey: `session:${params.sessionId}:mlflow_session:${mlflowSessionId}`,
        entityType: "session",
        entityId: params.sessionId,
        projectId: params.projectId ?? null,
        mlflowEntityType: "session",
        mlflowExperimentId: traceExperimentId,
        mlflowRunId: runId,
        mlflowSessionId,
        mlflowLoggedModelId: activeModelId ?? null,
        mlflowLoggedModelName: params.activeModelName ?? null,
        mlflowLoggedModelUri: params.activeModelUri ?? null,
        mlflowModelVersion: activeModelId ?? null,
        mlflowPublicUrl: publicUrl,
        tags: {
          source: "interactive_session",
          agentId: params.agentId,
          agentSlug,
          activeModelId,
          activeModelUri: params.activeModelUri ?? null,
        },
        metadata: {
          title: params.title ?? null,
          traceExperimentId,
          traceExperimentName,
        },
      })
      .onConflictDoUpdate({
        target: mlflowLineageLinks.sourceKey,
        set: {
          mlflowExperimentId: traceExperimentId,
          mlflowRunId: runId,
          mlflowSessionId,
          mlflowLoggedModelId: activeModelId ?? null,
          mlflowLoggedModelName: params.activeModelName ?? null,
          mlflowLoggedModelUri: params.activeModelUri ?? null,
          mlflowModelVersion: activeModelId ?? null,
          mlflowPublicUrl: publicUrl,
          updatedAt: new Date(),
        },
      });

    await tx
      .insert(mlflowLineageLinks)
      .values({
        sourceKey: `session:${params.sessionId}:run:${runId}`,
        entityType: "session",
        entityId: params.sessionId,
        projectId: params.projectId ?? null,
        mlflowEntityType: "run",
        mlflowExperimentId: runExperimentId,
        mlflowRunId: runId,
        mlflowSessionId,
        mlflowLoggedModelId: activeModelId ?? null,
        mlflowLoggedModelName: params.activeModelName ?? null,
        mlflowLoggedModelUri: params.activeModelUri ?? null,
        mlflowModelVersion: activeModelId ?? null,
        mlflowPublicUrl: publicUrl,
        tags: {
          source: "interactive_session_parent_run",
          agentId: params.agentId,
          agentSlug,
          activeModelId,
          activeModelUri: params.activeModelUri ?? null,
        },
        metadata: {},
      })
      .onConflictDoUpdate({
        target: mlflowLineageLinks.sourceKey,
        set: {
          mlflowExperimentId: runExperimentId,
          mlflowRunId: runId,
          mlflowSessionId,
          mlflowLoggedModelId: activeModelId ?? null,
          mlflowLoggedModelName: params.activeModelName ?? null,
          mlflowLoggedModelUri: params.activeModelUri ?? null,
          mlflowModelVersion: activeModelId ?? null,
          mlflowPublicUrl: publicUrl,
          updatedAt: new Date(),
        },
      });
  });

  await logRunJsonArtifact({
    runId,
    artifactPath: "session-manifest.json",
    value: {
      schemaVersion: 1,
      kind: "interactive_session",
      sessionId: params.sessionId,
      mlflowSessionId,
      title: params.title ?? null,
      projectId: params.projectId ?? null,
      userId: params.userId ?? null,
      agent: {
        id: params.agentId,
        name: params.agentName ?? null,
        slug: agentSlug,
        version: params.agentVersion ?? null,
        appId: params.agentAppId ?? null,
        mlflowModelId: activeModelId,
        mlflowModelName: params.activeModelName ?? null,
        mlflowModelUri: params.activeModelUri ?? null,
      },
      mlflow: {
        experimentId: runExperimentId,
        experimentName: runExperimentName,
        agentExperimentId,
        agentExperimentName,
        traceExperimentId,
        traceExperimentName,
        runId,
      },
    },
  }).catch((err) => {
    console.warn(
      `[mlflow] failed to log session manifest ${params.sessionId}:`,
      err instanceof Error ? err.message : err,
    );
  });

  return {
    experimentId: runExperimentId,
    experimentName: runExperimentName,
    traceExperimentId,
    traceExperimentName,
    runId,
    parentRunId: null,
    mlflowSessionId,
    publicUrl,
    activeModelId,
    activeModelName: params.activeModelName ?? null,
    activeModelUri: params.activeModelUri ?? null,
    applicationKind: "agent",
    applicationId: params.agentId,
  };
}

export async function safeCreateInteractiveSessionMlflowRun(
  params: Parameters<typeof createInteractiveSessionMlflowRun>[0],
): Promise<MlflowRunContext | null> {
  try {
    return await createInteractiveSessionMlflowRun(params);
  } catch (err) {
    console.warn(
      `[mlflow] failed to create interactive session run ${params.sessionId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export async function createWorkflowAgentMlflowRun(params: {
  sessionId: string;
  parentRunId: string;
  mlflowSessionId?: string | null;
  experimentId?: string | null;
  workflowExecutionId?: string | null;
  workflowId?: string | null;
  nodeId?: string | null;
  nodeName?: string | null;
  agentId?: string | null;
  agentVersion?: number | null;
  agentSlug?: string | null;
  agentAppId?: string | null;
  activeModelId?: string | null;
  activeModelName?: string | null;
  activeModelUri?: string | null;
  traceExperimentId?: string | null;
  traceExperimentName?: string | null;
  projectId?: string | null;
  userId?: string | null;
}): Promise<MlflowRunContext | null> {
  if (!mlflowLifecycleEnabled()) return null;
  if (!params.parentRunId.trim()) return null;
  const mlflowSessionId = params.mlflowSessionId?.trim() || params.sessionId;
  const fallbackExperiment =
    params.experimentId?.trim()
      ? null
      : await resolveCanonicalTraceMlflowExperiment();
  const experimentId = params.experimentId?.trim() || fallbackExperiment?.experimentId;
  if (!experimentId) return null;
  const runName = `agent/${params.agentSlug || params.agentId || "unknown"}/${params.sessionId.slice(0, 12)}`;
  const runId = await createMlflowRun({
    experimentId,
    runName,
    userId: params.userId ?? null,
    tags: [
      tag("mlflow.parentRunId", params.parentRunId),
      tag("workflow_builder.kind", "workflow_agent_run"),
      tag("workflow_builder.session_id", params.sessionId),
      tag("workflow_builder.mlflow_session_id", mlflowSessionId),
      tag("workflow_builder.workflow_execution_id", params.workflowExecutionId),
      tag("workflow_builder.trace_group_id", params.workflowExecutionId),
      tag("session.id", mlflowSessionId),
      tag("agent.session.id", mlflowSessionId),
      tag("workflow.execution.id", params.workflowExecutionId),
      tag("workflow_builder.workflow_id", params.workflowId),
      tag("workflow_builder.node_id", params.nodeId),
      tag("workflow_builder.node_name", params.nodeName),
      tag("workflow_builder.agent_id", params.agentId),
      tag("workflow_builder.agent_version", params.agentVersion),
      tag("workflow_builder.agent_slug", params.agentSlug),
      tag("workflow_builder.agent_app_id", params.agentAppId),
      tag("workflow_builder.agent_mlflow_uri", params.activeModelUri),
      tag("mlflow.modelId", params.activeModelId),
      tag("mlflow.model.uri", params.activeModelUri),
      tag(
        "workflow_builder.trace_experiment_id",
        params.traceExperimentId ?? experimentId,
      ),
      tag("workflow_builder.project_id", params.projectId),
      tag("workflow_builder.env", env.WORKFLOW_BUILDER_ENV ?? "unknown"),
    ],
  });
  const publicUrl = publicMlflowRunUrl(experimentId, runId);

  await db.transaction(async (tx) => {
    await tx
      .update(sessions)
      .set({
        mlflowExperimentId: experimentId,
        mlflowRunId: runId,
        mlflowParentRunId: params.parentRunId,
        mlflowSessionId,
      })
      .where(eq(sessions.id, params.sessionId));

    await tx
      .insert(mlflowLineageLinks)
      .values({
        sourceKey: `session:${params.sessionId}:run:${runId}`,
        entityType: "session",
        entityId: params.sessionId,
        projectId: params.projectId ?? null,
        mlflowEntityType: "run",
        mlflowExperimentId: experimentId,
        mlflowRunId: runId,
        mlflowSessionId,
        mlflowLoggedModelId: params.activeModelId ?? null,
        mlflowLoggedModelName: params.activeModelName ?? null,
        mlflowLoggedModelUri: params.activeModelUri ?? null,
        mlflowModelVersion: params.activeModelId ?? null,
        mlflowPublicUrl: publicUrl,
        tags: {
          parentRunId: params.parentRunId,
          workflowExecutionId: params.workflowExecutionId ?? null,
          workflowId: params.workflowId ?? null,
          nodeId: params.nodeId ?? null,
          agentId: params.agentId ?? null,
          agentSlug: params.agentSlug ?? null,
          activeModelId: params.activeModelId ?? null,
          activeModelUri: params.activeModelUri ?? null,
          source: "agent_session",
          traceGroupId: params.workflowExecutionId ?? null,
        },
        metadata: {},
      })
      .onConflictDoUpdate({
        target: mlflowLineageLinks.sourceKey,
        set: {
          mlflowExperimentId: experimentId,
          mlflowRunId: runId,
          mlflowSessionId,
          mlflowLoggedModelId: params.activeModelId ?? null,
          mlflowLoggedModelName: params.activeModelName ?? null,
          mlflowLoggedModelUri: params.activeModelUri ?? null,
          mlflowModelVersion: params.activeModelId ?? null,
          mlflowPublicUrl: publicUrl,
          updatedAt: new Date(),
        },
      });
  });

  return {
    experimentId,
    experimentName: fallbackExperiment?.experimentName ?? params.traceExperimentName ?? null,
    traceExperimentId: params.traceExperimentId ?? experimentId,
    traceExperimentName: params.traceExperimentName ?? fallbackExperiment?.experimentName ?? null,
    runId,
    parentRunId: params.parentRunId,
    mlflowSessionId,
    publicUrl,
    activeModelId: params.activeModelId ?? null,
    activeModelName: params.activeModelName ?? null,
    activeModelUri: params.activeModelUri ?? null,
    applicationKind: "workflow",
    applicationId: params.workflowId ?? null,
  };
}

export async function safeCreateWorkflowAgentMlflowRun(
  params: Parameters<typeof createWorkflowAgentMlflowRun>[0],
): Promise<MlflowRunContext | null> {
  try {
    return await createWorkflowAgentMlflowRun(params);
  } catch (err) {
    console.warn(
      `[mlflow] failed to create workflow agent run ${params.sessionId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export async function finishMlflowRun(params: {
  runId: string | null | undefined;
  status: "FINISHED" | "FAILED" | "KILLED";
  endTime?: number | Date | null;
}): Promise<void> {
  if (!mlflowLifecycleEnabled()) return;
  const runId = params.runId?.trim();
  if (!runId) return;
  const endTime =
    params.endTime instanceof Date
      ? params.endTime.getTime()
      : typeof params.endTime === "number"
        ? params.endTime
        : Date.now();
  await mlflowRequest("/api/2.0/mlflow/runs/update", {
    method: "POST",
    body: JSON.stringify({
      run_id: runId,
      status: params.status,
      end_time: endTime,
    }),
  });
}

export async function safeFinishMlflowRun(
  params: Parameters<typeof finishMlflowRun>[0],
): Promise<void> {
  try {
    await finishMlflowRun(params);
  } catch (err) {
    console.warn(
      `[mlflow] failed to finish run ${params.runId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

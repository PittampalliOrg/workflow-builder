import { env } from "$env/dynamic/private";
import { env as publicEnv } from "$env/dynamic/public";
import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
  agentVersions,
  mlflowLineageLinks,
  sessions,
  workflows,
  workflowExecutions,
  type Agent,
  type AgentVersion,
} from "$lib/server/db/schema";

type MlflowTag = { key: string; value: string };
type MlflowParam = { key: string; value: string };

type LoggedModelInfo = {
  model_id?: string;
  experiment_id?: string;
  name?: string;
  artifact_uri?: string;
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
  publicUrl: string | null;
  activeModelId?: string | null;
  activeModelName?: string | null;
  activeModelUri?: string | null;
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

function lifecycleExperimentName(): string {
  const configured = (env.MLFLOW_AGENT_EXPERIMENT_NAME ?? "").trim();
  if (configured) return configured;
  const cluster = (env.WORKFLOW_BUILDER_ENV ?? "unknown").trim() || "unknown";
  return `workflow-builder/${cluster}/agents`;
}

function workflowExperimentName(): string {
  const configured = (env.MLFLOW_WORKFLOW_EXPERIMENT_NAME ?? "").trim();
  if (configured) return configured;
  const cluster = (env.WORKFLOW_BUILDER_ENV ?? "unknown").trim() || "unknown";
  return `workflow-builder/${cluster}/workflows`;
}

function workflowScopedExperimentName(params: {
  workflowId: string;
  workflowName?: string | null;
}): string {
  const cluster = (env.WORKFLOW_BUILDER_ENV ?? "unknown").trim() || "unknown";
  const displayName = (params.workflowName ?? "").trim() || params.workflowId;
  const sanitizedName =
    displayName
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "workflow";
  const shortWorkflowId = params.workflowId
    .replace(/[^A-Za-z0-9]+/g, "")
    .slice(0, 12);
  return `workflow-builder/${cluster}/workflows/${sanitizedName}-${shortWorkflowId || "workflow"}`;
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

async function getOrCreateLifecycleExperimentId(): Promise<string> {
  return getOrCreateMlflowExperimentId(
    lifecycleExperimentName(),
    "agent_lifecycle",
  );
}

async function getOrCreateWorkflowExperimentId(): Promise<string> {
  return getOrCreateMlflowExperimentId(
    workflowExperimentName(),
    "workflow_runs",
  );
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

function tag(key: string, value: unknown): MlflowTag {
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
      mlflowExperimentId: workflows.mlflowExperimentId,
      mlflowExperimentName: workflows.mlflowExperimentName,
    })
    .from(workflows)
    .where(eq(workflows.id, params.workflowId))
    .limit(1);
  const workflowName = row?.name ?? params.workflowName ?? params.workflowId;
  const pinnedExperimentId = row?.mlflowExperimentId?.trim();
  const pinnedExperimentName = row?.mlflowExperimentName?.trim();
  const desiredExperimentName =
    pinnedExperimentName ||
    workflowScopedExperimentName({
      workflowId: params.workflowId,
      workflowName,
    });
  const experimentId =
    pinnedExperimentId ||
    (await getOrCreateMlflowExperimentId(
      desiredExperimentName,
      "workflow_runs",
      [
        tag("workflow_builder.workflow_id", params.workflowId),
        tag("workflow_builder.workflow_name", workflowName),
        tag("workflow_builder.project_id", row?.projectId ?? params.projectId),
      ],
    ));

  if (!pinnedExperimentId || !pinnedExperimentName) {
    await db
      .update(workflows)
      .set({
        mlflowExperimentId: experimentId,
        mlflowExperimentName: desiredExperimentName,
      })
      .where(eq(workflows.id, params.workflowId));
  }

  await setMlflowExperimentTags(experimentId, [
    tag("workflow_builder.workflow_id", params.workflowId),
    tag("workflow_builder.workflow_name", workflowName),
    tag("workflow_builder.project_id", row?.projectId ?? params.projectId),
    tag("workflow_builder.env", env.WORKFLOW_BUILDER_ENV ?? "unknown"),
  ]).catch((err) => {
    console.warn(
      `[mlflow] failed to update workflow experiment tags ${experimentId}:`,
      err instanceof Error ? err.message : err,
    );
  });

  await db
    .insert(mlflowLineageLinks)
    .values({
      sourceKey: `workflow:${params.workflowId}:experiment:${experimentId}`,
      entityType: "workflow",
      entityId: params.workflowId,
      projectId: row?.projectId ?? params.projectId ?? null,
      mlflowEntityType: "experiment",
      mlflowExperimentId: experimentId,
      mlflowPublicUrl: publicMlflowExperimentUrl(experimentId),
      tags: {
        workflowName,
        experimentName: desiredExperimentName,
      },
      metadata: {},
    })
    .onConflictDoUpdate({
      target: mlflowLineageLinks.sourceKey,
      set: {
        projectId: row?.projectId ?? params.projectId ?? null,
        mlflowExperimentId: experimentId,
        mlflowPublicUrl: publicMlflowExperimentUrl(experimentId),
        tags: {
          workflowName,
          experimentName: desiredExperimentName,
        },
        updatedAt: new Date(),
      },
    });

  return { experimentId, experimentName: desiredExperimentName };
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

function escapeMlflowFilterValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function findAgentVersionLoggedModel(
  experimentId: string,
  agentVersionId: string,
): Promise<LoggedModelResponse["model"] | null> {
  const payload = await mlflowRequest<{
    models?: NonNullable<LoggedModelResponse["model"]>[];
  }>("/api/2.0/mlflow/logged-models/search", {
    method: "POST",
    body: JSON.stringify({
      experiment_ids: [experimentId],
      filter: `tags.\`workflow_builder.agent_version_id\` = '${escapeMlflowFilterValue(agentVersionId)}'`,
      max_results: 1,
      order_by: [{ field_name: "creation_time", ascending: false }],
    }),
  });
  return payload.models?.[0] ?? null;
}

async function createAgentVersionLoggedModel(params: {
  experimentId: string;
  agent: Agent;
  version: AgentVersion;
}): Promise<NonNullable<LoggedModelResponse["model"]>> {
  const modelName = `${params.agent.slug}-v${params.version.version}`;
  const created = await mlflowRequest<LoggedModelResponse>(
    "/api/2.0/mlflow/logged-models",
    {
      method: "POST",
      body: JSON.stringify({
        experiment_id: params.experimentId,
        name: modelName,
        model_type: "Agent",
        params: [
          { key: "agent_id", value: params.agent.id },
          { key: "agent_slug", value: params.agent.slug },
          { key: "agent_version", value: String(params.version.version) },
          { key: "config_hash", value: params.version.configHash },
        ],
        tags: [
          { key: "workflow_builder.entity_type", value: "agent_version" },
          { key: "workflow_builder.agent_id", value: params.agent.id },
          { key: "workflow_builder.agent_slug", value: params.agent.slug },
          {
            key: "workflow_builder.agent_version_id",
            value: params.version.id,
          },
          {
            key: "workflow_builder.agent_version",
            value: String(params.version.version),
          },
          {
            key: "workflow_builder.project_id",
            value: params.agent.projectId ?? "",
          },
        ],
      }),
    },
  );
  if (!created.model?.info?.model_id) {
    throw new Error("MLflow logged model create returned no model id");
  }
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

export async function registerAgentVersionInMlflow(params: {
  agent: Agent;
  version: AgentVersion;
}): Promise<{
  modelId: string;
  modelName: string | null;
  modelUri: string;
} | null> {
  if (!mlflowLifecycleEnabled()) return null;
  if (params.version.mlflowUri?.trim()) {
    return {
      modelId: params.version.mlflowUri
        .trim()
        .replace(/^models:\//, "")
        .replace(/^\//, ""),
      modelName: params.version.mlflowModelName ?? null,
      modelUri: params.version.mlflowUri.trim(),
    };
  }

  const experimentId = await getOrCreateLifecycleExperimentId();
  const existing =
    (await findAgentVersionLoggedModel(experimentId, params.version.id)) ??
    (await createAgentVersionLoggedModel({
      experimentId,
      agent: params.agent,
      version: params.version,
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
        mlflowUri: modelUri,
        mlflowModelName: modelName,
        mlflowModelVersion: modelId,
      })
      .where(eq(agentVersions.id, params.version.id));

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
        },
        metadata: {
          artifactUri: info?.artifact_uri ?? null,
          status: info?.status ?? null,
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

export async function createWorkflowAgentMlflowRun(params: {
  sessionId: string;
  parentRunId: string;
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
  const experimentId =
    params.experimentId?.trim() || (await getOrCreateWorkflowExperimentId());
  const runName = `agent/${params.agentSlug || params.agentId || "unknown"}/${params.sessionId.slice(0, 12)}`;
  const runId = await createMlflowRun({
    experimentId,
    runName,
    userId: params.userId ?? null,
    tags: [
      tag("mlflow.parentRunId", params.parentRunId),
      tag("workflow_builder.kind", "workflow_agent_run"),
      tag("workflow_builder.session_id", params.sessionId),
      tag("workflow_builder.workflow_execution_id", params.workflowExecutionId),
      tag("workflow_builder.trace_group_id", params.workflowExecutionId),
      tag("session.id", params.sessionId),
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
    experimentName: null,
    traceExperimentId: params.traceExperimentId ?? experimentId,
    traceExperimentName: params.traceExperimentName ?? null,
    runId,
    parentRunId: params.parentRunId,
    publicUrl,
    activeModelId: params.activeModelId ?? null,
    activeModelName: params.activeModelName ?? null,
    activeModelUri: params.activeModelUri ?? null,
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

import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { assertExecutionReadModelColumns } from "$lib/server/db/execution-read-model-support";
import { workflows, workflowExecutions } from "$lib/server/db/schema";
import { daprFetch, getOrchestratorUrl } from "$lib/server/dapr-client";
import { getMissingRequiredTriggerFields } from "$lib/server/workflows/trigger-validation";
import { expandGreenfieldPromptInput } from "$lib/server/workflows/greenfield-prompt";
import { getRemovedSw10AgentCallsError } from "$lib/server/workflows/sw10-agent-validation";
import { assertInScope } from "$lib/server/workflows/project-scope";
import { validateTriggerModel } from "$lib/server/workflows/model-validation";
import { applyWorkflowInputDefaults } from "$lib/utils/workflow-input-config";
import {
  buildWorkflowSessionId,
  injectWorkflowSessionHeaders,
} from "$lib/server/observability/workflow-session";
import {
  resolveSpecAgentRefs,
  AgentRefResolutionError,
} from "$lib/server/agents/resolver";
import {
  safeCreateWorkflowExecutionMlflowRun,
  safeFinishMlflowRun,
} from "$lib/server/observability/mlflow-lifecycle";

/**
 * POST /api/workflows/[workflowId]/execute
 *
 * Executes a CNCF Serverless Workflow 1.0 document via the Dapr orchestrator.
 * This app only supports SW 1.0 — no legacy workflow formats.
 *
 * Pipeline:
 * 1. Fetch workflow from DB (must have spec.document.dsl === '1.0.0')
 * 2. Create execution record in DB
 * 3. Send spec to orchestrator POST /api/v2/sw-workflows
 * 4. Update execution with Dapr instance ID
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
  const { workflowId } = params;

  if (!db) return error(503, "Database not configured");
  if (!locals.session?.userId) return error(401, "Authentication required");
  try {
    await assertExecutionReadModelColumns();
  } catch (schemaError) {
    console.error(
      "[Execute] execution read-model schema check failed:",
      schemaError,
    );
    return error(
      503,
      schemaError instanceof Error
        ? schemaError.message
        : "Execution read-model migration is required",
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    // Empty body is fine
  }

  let triggerData = (body.input as Record<string, unknown>) ?? {};
  const userId = locals.session.userId;

  // Fetch workflow from DB
  const [workflow] = await db
    .select()
    .from(workflows)
    .where(eq(workflows.id, workflowId))
    .limit(1);

  if (!workflow) return error(404, "Workflow not found");

  // CMA scoping: if the caller has an active workspace (X-Workspace header
  // or /workspaces/[slug]/ URL) and the workflow belongs to a different
  // workspace, return 404 so existence isn't leaked across workspaces.
  // Pre-CMA workflows with a null project_id fall back to ownership check.
  assertInScope(
    { projectId: workflow.projectId ?? null, userId: workflow.userId },
    locals.session,
    "Workflow not found",
  );

  const storedSpec = (workflow as Record<string, unknown>).spec as Record<
    string,
    unknown
  > | null;

  if (!storedSpec || !isSWWorkflow(storedSpec)) {
    return error(
      400,
      "Workflow does not have a valid SW 1.0 spec. Save the workflow first to generate the spec from the canvas.",
    );
  }
  let spec = storedSpec as Record<string, unknown>;
  const removedAgentCallsError = getRemovedSw10AgentCallsError(spec);
  if (removedAgentCallsError) {
    return error(400, removedAgentCallsError);
  }

  // Resolve named-agent references. Fail-closed: any durable/run node without
  // an agentRef means the workflow predates the cutover and never got its
  // inline config backfilled. Run the admin backfill endpoint to migrate.
  try {
    spec = (await resolveSpecAgentRefs(spec)) as typeof spec;
  } catch (resolveErr) {
    if (resolveErr instanceof AgentRefResolutionError) {
      return error(400, resolveErr.message);
    }
    console.error("[Execute] agent ref resolution failed:", resolveErr);
    return error(
      500,
      resolveErr instanceof Error
        ? resolveErr.message
        : "Agent ref resolution failed",
    );
  }

  try {
    triggerData = applyWorkflowInputDefaults(spec, triggerData);
    triggerData = await expandGreenfieldPromptInput(spec, triggerData);
  } catch (expandError) {
    console.error("[Execute] greenfield prompt expansion failed:", expandError);
    return error(
      500,
      expandError instanceof Error
        ? expandError.message
        : "Failed to derive greenfield workflow inputs from prompt",
    );
  }

  const missingTriggerFields = getMissingRequiredTriggerFields(
    spec,
    triggerData,
  );
  if (missingTriggerFields.length > 0) {
    return error(
      400,
      `Missing required workflow input fields: ${missingTriggerFields.join(", ")}`,
    );
  }

  const modelError = await validateTriggerModel(spec, triggerData);
  if (modelError) {
    return error(400, modelError);
  }

  // Create execution record
  let execution;
  try {
    [execution] = await db
      .insert(workflowExecutions)
      .values({
        workflowId,
        userId,
        status: "running",
        phase: "running",
        progress: 0,
        input: triggerData,
        executionIrVersion: "sw-1.0",
        executionIr: { spec, triggerData },
      })
      .returning({
        id: workflowExecutions.id,
      });
  } catch (dbErr) {
    console.error("[Execute] DB insert failed:", dbErr);
    return error(500, "Failed to create execution record");
  }

  // Send to orchestrator's SW 1.0 endpoint
  const orchestratorUrl = getOrchestratorUrl();
  const sessionId = buildWorkflowSessionId(execution.id);
  const mlflowContext = await safeCreateWorkflowExecutionMlflowRun({
    executionId: execution.id,
    workflowId,
    workflowName: workflow.name,
    projectId: workflow.projectId ?? null,
    userId,
  });

  try {
    const headers = sessionId
      ? injectWorkflowSessionHeaders(
          { "Content-Type": "application/json" },
          {
            sessionId,
            workflowExecutionId: execution.id,
            workflowId,
            traceGroupId: execution.id,
            mlflowExperimentId:
              mlflowContext?.traceExperimentId ?? mlflowContext?.experimentId,
            mlflowRunId: mlflowContext?.runId,
            mlflowParentRunId: mlflowContext?.parentRunId,
          },
        )
      : { "Content-Type": "application/json" };

    const res = await daprFetch(`${orchestratorUrl}/api/v2/sw-workflows`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workflow: spec,
        workflowId,
        triggerData,
        dbExecutionId: execution.id,
        mlflowContext,
      }),
    });

    if (!res.ok) {
      const errBody = await res
        .json()
        .catch(() => ({ error: "Orchestrator error" }));
      console.error(`[Execute] Orchestrator ${res.status}:`, errBody);
      await db
        .update(workflowExecutions)
        .set({ status: "error", error: JSON.stringify(errBody).slice(0, 500) })
        .where(eq(workflowExecutions.id, execution.id));
      void safeFinishMlflowRun({
        runId: mlflowContext?.runId,
        status: "FAILED",
      });
      return error(
        res.status,
        errBody.error ??
          errBody.message ??
          errBody.detail ??
          "Failed to start workflow",
      );
    }

    const result = await res.json();

    await db
      .update(workflowExecutions)
      .set({
        daprInstanceId: result.instanceId,
        workflowSessionId: sessionId ?? execution.id,
      })
      .where(eq(workflowExecutions.id, execution.id));

    console.log(`[Execute] SW 1.0 workflow started: ${result.instanceId}`);

    return json({
      executionId: execution.id,
      instanceId: result.instanceId,
      workflowId,
      status: "running",
    });
  } catch (err) {
    console.error("[Execute] Orchestrator request failed:", err);
    await db
      .update(workflowExecutions)
      .set({ status: "error", error: String(err) })
      .where(eq(workflowExecutions.id, execution.id));
    void safeFinishMlflowRun({ runId: mlflowContext?.runId, status: "FAILED" });
    return error(502, "Workflow orchestrator unavailable");
  }
};

function isSWWorkflow(spec: unknown): boolean {
  if (typeof spec !== "object" || spec === null) return false;
  const w = spec as Record<string, unknown>;
  if (typeof w.document !== "object" || w.document === null) return false;
  const doc = w.document as Record<string, unknown>;
  return (
    doc.dsl === "1.0.0" &&
    typeof doc.namespace === "string" &&
    typeof doc.name === "string"
  );
}

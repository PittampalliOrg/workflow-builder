import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { getGenericOrchestratorUrl } from "@/lib/config-service";
import { genericOrchestratorClient } from "@/lib/dapr-client";
import { db } from "@/lib/db";
import { workflowExecutions, workflows } from "@/lib/db/schema";

/**
 * GET /api/dapr/workflows/[id]/status - Get Dapr workflow status
 * The [id] is the local execution ID, not the Dapr instance ID.
 *
 * The orchestrator returns a flat status response:
 *   { workflow_id, runtime_status, phase, progress, message, output }
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;

    const session = await getSession(request);

    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get execution record
    const execution = await db.query.workflowExecutions.findFirst({
      where: eq(workflowExecutions.id, id),
    });

    if (!execution) {
      return NextResponse.json(
        { error: "Execution not found" },
        { status: 404 }
      );
    }

    if (execution.userId !== session.user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (!execution.daprInstanceId) {
      return NextResponse.json(
        { error: "Not a Dapr workflow execution" },
        { status: 400 }
      );
    }

    // Get the orchestrator URL from the workflow
    // Use config service (Azure App Config via Dapr) with fallback to defaults
    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, execution.workflowId),
    });
    const defaultOrchestratorUrl = await getGenericOrchestratorUrl();
    const orchestratorUrl =
      workflow?.daprOrchestratorUrl || defaultOrchestratorUrl;

    // Fetch status from generic orchestrator (v2 API)
    const orchestratorStatus =
      await genericOrchestratorClient.getWorkflowStatus(
        orchestratorUrl,
        execution.daprInstanceId
      );

    // Extract fields from orchestrator response
    const phase = orchestratorStatus.phase || null;
    const progress = orchestratorStatus.progress ?? null;
    const message = orchestratorStatus.message || null;

    // Map orchestrator runtimeStatus to our execution status
    // Also check phase and outputs.success since orchestrator may return
    // COMPLETED even when workflow internally failed
    let localStatus = execution.status;
    let errorMessage: string | null = orchestratorStatus.error || null;
    const outputs = orchestratorStatus.outputs as
      | Record<string, unknown>
      | undefined;
    const outputSuccess = outputs?.success;

    if (orchestratorStatus.runtimeStatus === "COMPLETED") {
      // Check if workflow actually succeeded or failed internally
      if (phase === "failed" || outputSuccess === false) {
        localStatus = "error";
        errorMessage =
          errorMessage ||
          message ||
          (outputs?.error as string) ||
          "Workflow failed";
      } else {
        localStatus = "success";
      }
    } else if (
      orchestratorStatus.runtimeStatus === "FAILED" ||
      orchestratorStatus.runtimeStatus === "TERMINATED"
    ) {
      localStatus = "error";
      errorMessage = errorMessage || message || "Workflow failed";
    } else if (orchestratorStatus.runtimeStatus === "RUNNING") {
      localStatus = "running";
    } else if (orchestratorStatus.runtimeStatus === "UNKNOWN") {
      // UNKNOWN typically means workflow completed and was purged from runtime
      // Check phase and outputs to determine actual status
      if (phase === "completed" || outputSuccess === true) {
        localStatus = "success";
      } else if (phase === "failed" || outputSuccess === false) {
        localStatus = "error";
        errorMessage =
          errorMessage ||
          message ||
          (outputs?.error as string) ||
          "Workflow failed";
      }
      // If phase/outputs don't indicate completion, keep current status
    }

    await db
      .update(workflowExecutions)
      .set({
        status: localStatus,
        phase,
        progress,
        ...(errorMessage ? { error: errorMessage } : {}),
        ...(localStatus === "success" || localStatus === "error"
          ? { completedAt: new Date() }
          : {}),
      })
      .where(eq(workflowExecutions.id, id));

    return NextResponse.json({
      executionId: id,
      daprInstanceId: execution.daprInstanceId,
      status: localStatus,
      daprStatus: orchestratorStatus.runtimeStatus,
      phase,
      progress,
      message,
      currentNodeId: orchestratorStatus.currentNodeId || null,
      currentNodeName: orchestratorStatus.currentNodeName || null,
      output: orchestratorStatus.outputs,
    });
  } catch (error) {
    console.error("[Dapr API] Failed to get workflow status:", error);

    // If the Dapr orchestrator can't find the workflow, mark the execution as error
    // to stop the infinite polling loop
    const errorMessage =
      error instanceof Error ? error.message : "Failed to get workflow status";
    const isNotFound =
      errorMessage.includes("404") ||
      errorMessage.toLowerCase().includes("not found");

    if (isNotFound) {
      const { id } = await context.params;
      try {
        await db
          .update(workflowExecutions)
          .set({
            status: "error",
            error: "Workflow instance not found in orchestrator",
            completedAt: new Date(),
          })
          .where(eq(workflowExecutions.id, id));
      } catch (dbError) {
        console.error("[Dapr API] Failed to update execution status:", dbError);
      }
    }

    return NextResponse.json(
      {
        error: errorMessage,
      },
      { status: isNotFound ? 404 : 500 }
    );
  }
}

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { workflowExecutions, workflows } from "@/lib/db/schema";
import { daprClient } from "@/lib/dapr-client";

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

    const session = await auth.api.getSession({
      headers: request.headers,
    });

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
    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, execution.workflowId),
    });
    const orchestratorUrl =
      workflow?.daprOrchestratorUrl ||
      process.env.DAPR_ORCHESTRATOR_URL ||
      "http://planner-orchestrator:8080";

    // Fetch status from Dapr orchestrator (flat response)
    const daprStatus = await daprClient.getWorkflowStatus(
      orchestratorUrl,
      execution.daprInstanceId
    );

    // Extract flat fields from orchestrator response
    const phase = daprStatus.phase || null;
    const progress = daprStatus.progress ?? null;
    const message = daprStatus.message || null;

    // Map Dapr runtime_status to our execution status
    // Also check phase and output.success since orchestrator may return
    // COMPLETED even when workflow internally failed
    let localStatus = execution.status;
    let errorMessage: string | null = null;

    if (daprStatus.runtime_status === "COMPLETED") {
      // Check if workflow actually succeeded or failed internally
      const outputSuccess = (daprStatus.output as Record<string, unknown>)?.success;
      if (phase === "failed" || outputSuccess === false) {
        localStatus = "error";
        errorMessage = message || (daprStatus.output as Record<string, unknown>)?.error as string || "Workflow failed";
      } else {
        localStatus = "success";
      }
    } else if (
      daprStatus.runtime_status === "FAILED" ||
      daprStatus.runtime_status === "TERMINATED"
    ) {
      localStatus = "error";
      errorMessage = message || "Workflow failed";
    } else if (daprStatus.runtime_status === "RUNNING") {
      localStatus = "running";
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
      daprStatus: daprStatus.runtime_status,
      phase,
      progress,
      message,
      output: daprStatus.output,
    });
  } catch (error) {
    console.error("[Dapr API] Failed to get workflow status:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to get workflow status",
      },
      { status: 500 }
    );
  }
}

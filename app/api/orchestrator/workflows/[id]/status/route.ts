/**
 * GET /api/orchestrator/workflows/[id]/status - Get workflow status
 *
 * Polls the orchestrator for the current workflow status and
 * updates the local execution record.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { workflowExecutions, workflows } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { genericOrchestratorClient } from "@/lib/dapr-client";
import { getOrchestratorUrlAsync } from "@/lib/dapr/config-provider";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: executionId } = await params;

    // Authenticate the request
    const session = await auth.api.getSession({
      headers: await headers(),
    });

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Fetch the execution record
    const [execution] = await db
      .select()
      .from(workflowExecutions)
      .where(eq(workflowExecutions.id, executionId))
      .limit(1);

    if (!execution) {
      return NextResponse.json(
        { error: "Execution not found" },
        { status: 404 }
      );
    }

    // Check if user has access
    if (execution.userId !== session.user.id) {
      // Check if user owns the workflow
      const [workflow] = await db
        .select()
        .from(workflows)
        .where(eq(workflows.id, execution.workflowId))
        .limit(1);

      if (!workflow || (workflow.userId !== session.user.id && workflow.visibility !== "public")) {
        return NextResponse.json(
          { error: "Access denied" },
          { status: 403 }
        );
      }
    }

    // If we have a Dapr instance ID, poll the orchestrator
    if (execution.daprInstanceId) {
      // Get orchestrator URL from workflow
      const [workflow] = await db
        .select()
        .from(workflows)
        .where(eq(workflows.id, execution.workflowId))
        .limit(1);

      const defaultUrl = await getOrchestratorUrlAsync();
      const orchestratorUrl = workflow?.daprOrchestratorUrl || defaultUrl;

      try {
        const status = await genericOrchestratorClient.getWorkflowStatus(
          orchestratorUrl,
          execution.daprInstanceId
        );

        // Map runtime status to local status
        const localStatus = mapRuntimeStatusToLocalStatus(status.runtimeStatus);

        // Update execution record if status changed
        if (
          localStatus !== execution.status ||
          status.phase !== execution.phase ||
          status.progress !== execution.progress
        ) {
          await db
            .update(workflowExecutions)
            .set({
              status: localStatus,
              phase: status.phase,
              progress: status.progress,
              output: status.outputs || null,
              ...(localStatus === "success" || localStatus === "error" || localStatus === "cancelled"
                ? { completedAt: new Date() }
                : {}),
            })
            .where(eq(workflowExecutions.id, executionId));
        }

        return NextResponse.json({
          executionId,
          instanceId: execution.daprInstanceId,
          workflowId: execution.workflowId,
          status: localStatus,
          runtimeStatus: status.runtimeStatus,
          phase: status.phase,
          progress: status.progress,
          message: status.message,
          currentNodeId: status.currentNodeId,
          currentNodeName: status.currentNodeName,
          outputs: status.outputs,
          error: status.error,
          startedAt: execution.startedAt,
          completedAt: status.completedAt,
        });
      } catch (pollError) {
        console.error("[Orchestrator API] Error polling status:", pollError);
        // Return cached status if polling fails
        return NextResponse.json({
          executionId,
          instanceId: execution.daprInstanceId,
          workflowId: execution.workflowId,
          status: execution.status,
          phase: execution.phase,
          progress: execution.progress,
          startedAt: execution.startedAt,
          error: "Failed to poll orchestrator",
        });
      }
    }

    // Return cached status if no instance ID
    return NextResponse.json({
      executionId,
      workflowId: execution.workflowId,
      status: execution.status,
      phase: execution.phase,
      progress: execution.progress,
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("[Orchestrator API] Error getting workflow status:", error);

    return NextResponse.json(
      { error: "Failed to get workflow status", message: errorMessage },
      { status: 500 }
    );
  }
}

/**
 * Map Dapr runtime status to local execution status
 */
function mapRuntimeStatusToLocalStatus(
  runtimeStatus: string
): "pending" | "running" | "success" | "error" | "cancelled" {
  switch (runtimeStatus.toUpperCase()) {
    case "COMPLETED":
      return "success";
    case "FAILED":
      return "error";
    case "TERMINATED":
      return "cancelled";
    case "PENDING":
      return "pending";
    case "RUNNING":
    case "SUSPENDED":
    default:
      return "running";
  }
}

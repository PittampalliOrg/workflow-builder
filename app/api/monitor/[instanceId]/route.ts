import { asc, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { getWorkflowOrchestratorUrl } from "@/lib/config-service";
import { db } from "@/lib/db";
import {
  workflowExecutionLogs,
  workflowExecutions,
  workflows,
} from "@/lib/db/schema";
import {
  mapWorkflowStatus,
  toWorkflowDetail,
} from "@/lib/transforms/workflow-ui";

export const dynamic = "force-dynamic";

/**
 * Dapr workflow status response from orchestrator
 */
type DaprWorkflowStatus = {
  instanceId: string;
  workflowId: string;
  runtimeStatus:
    | "RUNNING"
    | "COMPLETED"
    | "FAILED"
    | "TERMINATED"
    | "PENDING"
    | "SUSPENDED"
    | "UNKNOWN";
  phase?: string;
  progress?: number;
  message?: string;
  currentNodeId?: string;
  currentNodeName?: string;
  outputs?: unknown;
  error?: string;
  startedAt?: string;
  completedAt?: string;
};

/**
 * Fetch real-time workflow status from Dapr via orchestrator
 */
async function fetchDaprWorkflowStatus(
  daprInstanceId: string
): Promise<DaprWorkflowStatus | null> {
  try {
    const orchestratorUrl = await getWorkflowOrchestratorUrl();
    const url = `${orchestratorUrl}/api/v2/workflows/${encodeURIComponent(daprInstanceId)}/status`;

    const response = await fetch(url, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      // Short timeout to avoid blocking if orchestrator is unavailable
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) {
      console.warn(
        `[Monitor] Failed to fetch Dapr status for ${daprInstanceId}: ${response.status}`
      );
      return null;
    }

    return (await response.json()) as DaprWorkflowStatus;
  } catch (error) {
    // Don't fail the request if Dapr status is unavailable
    console.warn(
      `[Monitor] Could not fetch Dapr status for ${daprInstanceId}:`,
      error
    );
    return null;
  }
}

/**
 * GET /api/monitor/[instanceId]
 * Get detailed information for a single workflow execution
 * Merges PostgreSQL data with real-time Dapr status
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ instanceId: string }> }
) {
  try {
    const { instanceId } = await params;

    // Fetch execution with workflow from PostgreSQL
    const [result] = await db
      .select({
        execution: workflowExecutions,
        workflow: workflows,
      })
      .from(workflowExecutions)
      .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
      .where(eq(workflowExecutions.id, instanceId))
      .limit(1);

    if (!result) {
      return NextResponse.json(
        { error: "Workflow execution not found" },
        { status: 404 }
      );
    }

    // Fetch execution logs from PostgreSQL
    const logs = await db
      .select()
      .from(workflowExecutionLogs)
      .where(eq(workflowExecutionLogs.executionId, instanceId))
      .orderBy(asc(workflowExecutionLogs.timestamp));

    // Transform PostgreSQL data to UI format
    const detail = toWorkflowDetail(result.execution, result.workflow, logs);

    // If we have a Dapr instance ID, fetch real-time status from Dapr
    const daprInstanceId = result.execution.daprInstanceId;
    if (daprInstanceId) {
      const daprStatus = await fetchDaprWorkflowStatus(daprInstanceId);

      if (daprStatus) {
        // Merge Dapr real-time status with PostgreSQL data
        // Dapr status is authoritative for running workflows
        detail.daprStatus = {
          runtimeStatus: daprStatus.runtimeStatus,
          phase: daprStatus.phase,
          progress: daprStatus.progress,
          message: daprStatus.message,
          currentNodeId: daprStatus.currentNodeId,
          currentNodeName: daprStatus.currentNodeName,
          error: daprStatus.error,
        };

        // Update status from Dapr if it's a known valid status
        // UNKNOWN means Dapr doesn't have the workflow (purged/not found) - trust PostgreSQL instead
        if (
          daprStatus.runtimeStatus &&
          daprStatus.runtimeStatus !== "UNKNOWN"
        ) {
          const daprMappedStatus = mapWorkflowStatus(daprStatus.runtimeStatus);

          // Dapr is authoritative for active workflows
          // If Dapr says it's RUNNING but DB says completed, trust Dapr (DB hasn't caught up)
          // If Dapr says COMPLETED/FAILED but DB says running, trust Dapr (more current)
          if (daprMappedStatus !== detail.status) {
            detail.status = daprMappedStatus;
          }
        }
        // If Dapr status is UNKNOWN, PostgreSQL status is authoritative (workflow may be purged)

        // Update phase and progress from Dapr (more real-time)
        if (daprStatus.phase) {
          detail.customStatus = {
            ...detail.customStatus,
            phase: daprStatus.phase as
              | "clone"
              | "exploration"
              | "planning"
              | "awaiting_approval"
              | "executing"
              | "completed"
              | "failed",
            progress: daprStatus.progress ?? detail.customStatus?.progress ?? 0,
            message: daprStatus.message ?? detail.customStatus?.message ?? "",
            currentTask: daprStatus.currentNodeName,
          };
        }

        // Update error from Dapr if present
        if (daprStatus.error && !detail.output) {
          detail.output = { error: daprStatus.error };
        }
      }
    }

    return NextResponse.json(detail);
  } catch (error) {
    console.error("Error fetching workflow execution detail:", error);
    return NextResponse.json(
      { error: "Failed to fetch workflow execution detail" },
      { status: 500 }
    );
  }
}

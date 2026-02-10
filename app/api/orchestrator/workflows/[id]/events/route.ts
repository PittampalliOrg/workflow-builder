/**
 * POST /api/orchestrator/workflows/[id]/events - Raise an event
 *
 * Raises an external event to a running workflow.
 * Used for approval gates and other event-driven patterns.
 */

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { getOrchestratorUrlAsync } from "@/lib/dapr/config-provider";
import { genericOrchestratorClient } from "@/lib/dapr-client";
import { db } from "@/lib/db";
import { workflowExecutions, workflows } from "@/lib/db/schema";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: executionId } = await params;

    // Authenticate the request
    const session = await getSession(request);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Parse request body
    const body = await request.json();
    const { eventName, eventData } = body;

    if (!eventName) {
      return NextResponse.json(
        { error: "eventName is required" },
        { status: 400 }
      );
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
      const [workflow] = await db
        .select()
        .from(workflows)
        .where(eq(workflows.id, execution.workflowId))
        .limit(1);

      if (!workflow || workflow.userId !== session.user.id) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
    }

    // Check if we have a Dapr instance ID
    if (!execution.daprInstanceId) {
      return NextResponse.json(
        { error: "Execution has no Dapr instance" },
        { status: 400 }
      );
    }

    // Get orchestrator URL from workflow
    const [workflow] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, execution.workflowId))
      .limit(1);

    const defaultUrl = await getOrchestratorUrlAsync();
    const orchestratorUrl = workflow?.daprOrchestratorUrl || defaultUrl;

    // Raise the event
    const result = await genericOrchestratorClient.raiseEvent(
      orchestratorUrl,
      execution.daprInstanceId,
      eventName,
      eventData
    );

    console.log(
      `[Orchestrator API] Raised event ${eventName} for execution ${executionId}`
    );

    return NextResponse.json({
      success: result.success,
      executionId,
      instanceId: execution.daprInstanceId,
      eventName,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("[Orchestrator API] Error raising event:", error);

    return NextResponse.json(
      { error: "Failed to raise event", message: errorMessage },
      { status: 500 }
    );
  }
}

/**
 * POST /api/orchestrator/workflows/[id]/events/approve - Approve a workflow
 *
 * Convenience endpoint for approving workflows waiting at approval gates.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: executionId } = await params;

    // Authenticate the request
    const session = await getSession(request);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Parse request body
    const body = await request.json();
    const { approved, reason, eventName = "approval" } = body;

    if (typeof approved !== "boolean") {
      return NextResponse.json(
        { error: "approved (boolean) is required" },
        { status: 400 }
      );
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
      const [workflow] = await db
        .select()
        .from(workflows)
        .where(eq(workflows.id, execution.workflowId))
        .limit(1);

      if (!workflow || workflow.userId !== session.user.id) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
    }

    // Check if we have a Dapr instance ID
    if (!execution.daprInstanceId) {
      return NextResponse.json(
        { error: "Execution has no Dapr instance" },
        { status: 400 }
      );
    }

    // Get orchestrator URL from workflow
    const [workflow] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, execution.workflowId))
      .limit(1);

    const defaultUrl = await getOrchestratorUrlAsync();
    const orchestratorUrl = workflow?.daprOrchestratorUrl || defaultUrl;

    // Raise the approval event
    const result = await genericOrchestratorClient.raiseEvent(
      orchestratorUrl,
      execution.daprInstanceId,
      eventName,
      { approved, reason, approvedBy: session.user.email || session.user.id }
    );

    console.log(
      `[Orchestrator API] ${approved ? "Approved" : "Rejected"} execution ${executionId}`
    );

    return NextResponse.json({
      success: result.success,
      executionId,
      instanceId: execution.daprInstanceId,
      approved,
      reason,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("[Orchestrator API] Error approving workflow:", error);

    return NextResponse.json(
      { error: "Failed to approve workflow", message: errorMessage },
      { status: 500 }
    );
  }
}

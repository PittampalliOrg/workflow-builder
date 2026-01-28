import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { workflowExecutions, workflows } from "@/lib/db/schema";
import { daprClient } from "@/lib/dapr-client";

/**
 * GET /api/dapr/workflows - List Dapr workflow executions for the current user
 */
export async function GET(request: Request) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get all Dapr workflow executions for this user
    const executions = await db.query.workflowExecutions.findMany({
      where: eq(workflowExecutions.userId, session.user.id),
    });

    // Sort by startedAt descending
    executions.sort(
      (a, b) =>
        new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );

    // Filter to only Dapr executions (those with daprInstanceId)
    const daprExecutions = executions
      .filter((e) => e.daprInstanceId)
      .map((e) => ({
        id: e.id,
        workflowId: e.workflowId,
        daprInstanceId: e.daprInstanceId,
        status: e.status,
        phase: e.phase,
        progress: e.progress,
        startedAt: e.startedAt,
        completedAt: e.completedAt,
      }));

    return NextResponse.json(daprExecutions);
  } catch (error) {
    console.error("[Dapr API] Failed to list workflows:", error);
    return NextResponse.json(
      { error: "Failed to list workflows" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/dapr/workflows - Start a new Dapr workflow
 *
 * The orchestrator expects { feature_request, cwd } and returns { workflow_id, status }.
 */
export async function POST(request: Request) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { workflowId, featureRequest, cwd = "" } = body;

    if (!workflowId) {
      return NextResponse.json(
        { error: "workflowId is required" },
        { status: 400 }
      );
    }

    if (!featureRequest) {
      return NextResponse.json(
        { error: "featureRequest is required" },
        { status: 400 }
      );
    }

    // Get workflow and verify ownership
    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!workflow) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    if (workflow.userId !== session.user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const orchestratorUrl =
      workflow.daprOrchestratorUrl ||
      process.env.DAPR_ORCHESTRATOR_URL ||
      "http://planner-orchestrator:8080";

    // Create execution record
    const [execution] = await db
      .insert(workflowExecutions)
      .values({
        workflowId,
        userId: session.user.id,
        status: "running",
        input: { feature_request: featureRequest, cwd },
      })
      .returning();

    // Start the Dapr workflow via orchestrator
    const result = await daprClient.startWorkflow(
      orchestratorUrl,
      featureRequest,
      cwd
    );

    // Update execution with Dapr workflow ID (orchestrator returns workflow_id)
    await db
      .update(workflowExecutions)
      .set({ daprInstanceId: result.workflow_id })
      .where(eq(workflowExecutions.id, execution.id));

    return NextResponse.json({
      executionId: execution.id,
      daprInstanceId: result.workflow_id,
      status: "running",
    });
  } catch (error) {
    console.error("[Dapr API] Failed to start workflow:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to start workflow",
      },
      { status: 500 }
    );
  }
}

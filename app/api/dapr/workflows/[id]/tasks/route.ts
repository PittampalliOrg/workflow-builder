import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { daprClient } from "@/lib/dapr-client";
import { db } from "@/lib/db";
import { workflowExecutions, workflows } from "@/lib/db/schema";

/**
 * GET /api/dapr/workflows/[id]/tasks - Get tasks from Dapr statestore
 *
 * The orchestrator returns { workflow_id, tasks, count }.
 * We unwrap and return the tasks array.
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

    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, execution.workflowId),
    });
    const orchestratorUrl =
      workflow?.daprOrchestratorUrl ||
      process.env.DAPR_ORCHESTRATOR_URL ||
      "http://planner-dapr-agent:8000";

    // Orchestrator returns { workflow_id, tasks, count }
    const response = await daprClient.getWorkflowTasks(
      orchestratorUrl,
      execution.daprInstanceId
    );

    // Return unwrapped tasks array with count
    return NextResponse.json({
      tasks: response.tasks,
      count: response.count,
    });
  } catch (error) {
    console.error("[Dapr API] Failed to get workflow tasks:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to get workflow tasks",
      },
      { status: 500 }
    );
  }
}

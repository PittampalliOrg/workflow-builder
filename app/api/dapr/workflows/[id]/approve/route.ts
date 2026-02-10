import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { daprClient } from "@/lib/dapr-client";
import { db } from "@/lib/db";
import { workflowExecutions, workflows } from "@/lib/db/schema";

/**
 * POST /api/dapr/workflows/[id]/approve - Approve or reject a Dapr workflow
 */
export async function POST(
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

    const body = await request.json();
    const { approved, reason } = body;

    if (typeof approved !== "boolean") {
      return NextResponse.json(
        { error: "approved (boolean) is required" },
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

    const result = await daprClient.approveWorkflow(
      orchestratorUrl,
      execution.daprInstanceId,
      approved,
      reason
    );

    return NextResponse.json(result);
  } catch (error) {
    console.error("[Dapr API] Failed to approve workflow:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to approve workflow",
      },
      { status: 500 }
    );
  }
}

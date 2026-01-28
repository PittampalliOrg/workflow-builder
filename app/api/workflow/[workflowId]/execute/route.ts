import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { validateWorkflowIntegrations } from "@/lib/db/integrations";
import { workflowExecutions, workflows } from "@/lib/db/schema";
import { daprClient } from "@/lib/dapr-client";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow-store";

export async function POST(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
) {
  try {
    const { workflowId } = await context.params;

    // Get session
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

    // Parse request body
    const body = await request.json().catch(() => ({}));
    const input = body.input || {};

    // Route based on engine type
    const engineType = (workflow as Record<string, unknown>).engineType as string | undefined;

    if (engineType === "dapr") {
      // Dapr workflow execution - proxy to orchestrator
      const orchestratorUrl =
        ((workflow as Record<string, unknown>).daprOrchestratorUrl as string) ||
        process.env.DAPR_ORCHESTRATOR_URL ||
        "http://planner-orchestrator:8080";

      // Create execution record
      const [execution] = await db
        .insert(workflowExecutions)
        .values({
          workflowId,
          userId: session.user.id,
          status: "running",
          input,
        })
        .returning();

      try {
        // Extract feature_request and cwd from input for the orchestrator
        const featureRequest =
          (input.feature_request as string) ||
          (input.featureRequest as string) ||
          "";
        const cwd = (input.cwd as string) || "";

        const daprResult = await daprClient.startWorkflow(
          orchestratorUrl,
          featureRequest,
          cwd
        );

        // Update execution with Dapr workflow ID
        await db
          .update(workflowExecutions)
          .set({
            daprInstanceId: daprResult.workflow_id,
          })
          .where(eq(workflowExecutions.id, execution.id));

        return NextResponse.json({
          executionId: execution.id,
          daprInstanceId: daprResult.workflow_id,
          status: "running",
        });
      } catch (daprError) {
        // Update execution with error
        await db
          .update(workflowExecutions)
          .set({
            status: "error",
            error:
              daprError instanceof Error
                ? daprError.message
                : "Failed to start Dapr workflow",
            completedAt: new Date(),
          })
          .where(eq(workflowExecutions.id, execution.id));

        return NextResponse.json(
          {
            error:
              daprError instanceof Error
                ? daprError.message
                : "Failed to start Dapr workflow",
          },
          { status: 502 }
        );
      }
    }

    // Legacy Vercel workflow execution path
    // Validate integrations for legacy workflows
    const validation = await validateWorkflowIntegrations(
      workflow.nodes as WorkflowNode[],
      session.user.id
    );
    if (!validation.valid) {
      return NextResponse.json(
        { error: "Workflow contains invalid integration references" },
        { status: 403 }
      );
    }

    // Create execution record
    const [execution] = await db
      .insert(workflowExecutions)
      .values({
        workflowId,
        userId: session.user.id,
        status: "running",
        input,
      })
      .returning();

    // For legacy workflows, execution is no longer supported without the Vercel Workflow SDK
    // Mark as error since the executor has been removed
    await db
      .update(workflowExecutions)
      .set({
        status: "error",
        error:
          "Legacy Vercel workflow execution is no longer supported. Please migrate this workflow to use Dapr.",
        completedAt: new Date(),
      })
      .where(eq(workflowExecutions.id, execution.id));

    return NextResponse.json({
      executionId: execution.id,
      status: "error",
      error:
        "Legacy Vercel workflow execution is no longer supported. Please migrate this workflow to use Dapr.",
    });
  } catch (error) {
    console.error("Failed to start workflow execution:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to execute workflow",
      },
      { status: 500 }
    );
  }
}

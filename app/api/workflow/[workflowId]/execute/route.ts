import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { validateWorkflowIntegrations } from "@/lib/db/integrations";
import { workflowExecutions, workflowExecutionLogs, workflows } from "@/lib/db/schema";
import { daprClient } from "@/lib/dapr-client";
import { executeWorkflow } from "@/lib/workflow-executor";
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

    // Check if this is a planning workflow (has feature_request) or direct execution
    // First check request body input, then check activity node configs
    let featureRequest =
      (input.feature_request as string) ||
      (input.featureRequest as string) ||
      "";
    let cwd = (input.cwd as string) || "";

    // For Dapr workflows, extract feature_request and cwd from activity node config if not in input
    if (engineType === "dapr" && !featureRequest) {
      const nodes = workflow.nodes as WorkflowNode[];
      for (const node of nodes) {
        if (node.type === "activity") {
          const data = node.data as Record<string, unknown>;
          const config = (data.config as Record<string, unknown>) || {};
          // Check for prompt/feature_request in activity config
          if (config.prompt && typeof config.prompt === "string") {
            featureRequest = config.prompt;
          } else if (config.feature_request && typeof config.feature_request === "string") {
            featureRequest = config.feature_request;
          }
          // Check for cwd in activity config
          if (!cwd && config.cwd && typeof config.cwd === "string") {
            cwd = config.cwd;
          }
          if (featureRequest) break; // Found what we need
        }
      }
    }

    if (engineType === "dapr" && featureRequest) {
      // Dapr planning workflow - proxy to planner-orchestrator
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

    // Direct workflow execution using activity-executor
    // This executes the visual workflow nodes directly

    // Validate integrations
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

    // Execute workflow asynchronously
    // We return immediately and the execution continues in the background
    executeWorkflowAsync(
      execution.id,
      workflowId,
      workflow.nodes as WorkflowNode[],
      workflow.edges as WorkflowEdge[],
      session.user.id
    );

    return NextResponse.json({
      executionId: execution.id,
      status: "running",
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

/**
 * Execute workflow asynchronously and update database with results
 */
async function executeWorkflowAsync(
  executionId: string,
  workflowId: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  userId: string
) {
  try {
    // Execute the workflow
    const result = await executeWorkflow(
      nodes,
      edges,
      executionId,
      workflowId,
      async (nodeId, status, output) => {
        // Log each node execution
        if (output) {
          await db.insert(workflowExecutionLogs).values({
            executionId,
            nodeId,
            nodeName: output.label,
            nodeType: "action",
            status: output.success ? "success" : "error",
            input: {},
            output: output.data as Record<string, unknown> | null,
            error: output.error,
          });
        }
      }
    );

    // Update execution with final result
    await db
      .update(workflowExecutions)
      .set({
        status: result.success ? "success" : "error",
        output: result.outputs as Record<string, unknown>,
        error: result.error,
        completedAt: new Date(),
      })
      .where(eq(workflowExecutions.id, executionId));
  } catch (error) {
    // Update execution with error
    await db
      .update(workflowExecutions)
      .set({
        status: "error",
        error: error instanceof Error ? error.message : "Workflow execution failed",
        completedAt: new Date(),
      })
      .where(eq(workflowExecutions.id, executionId));
  }
}

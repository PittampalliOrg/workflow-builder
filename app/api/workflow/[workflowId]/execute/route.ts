import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import {
  getDaprOrchestratorUrl,
  getGenericOrchestratorUrl,
} from "@/lib/config-service";
import { daprClient, genericOrchestratorClient } from "@/lib/dapr-client";
import { db } from "@/lib/db";
import { validateWorkflowAppConnections } from "@/lib/db/app-connections";
import {
  workflowExecutionLogs,
  workflowExecutions,
  workflows,
} from "@/lib/db/schema";
import { generateWorkflowDefinition } from "@/lib/workflow-definition";
import { executeWorkflow } from "@/lib/workflow-executor";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow-store";

export async function POST(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
) {
  try {
    const { workflowId } = await context.params;

    // Get session
    const session = await getSession(request);

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
    const engineType = (workflow as Record<string, unknown>).engineType as
      | string
      | undefined;

    // Check if this is a planning workflow (has feature_request) or direct execution
    // First check request body input, then check activity node configs
    let featureRequest =
      (input.feature_request as string) ||
      (input.featureRequest as string) ||
      "";
    let cwd = (input.cwd as string) || "";

    // For Dapr workflows, extract feature_request and cwd from activity node config if not in input
    // Only look for explicit feature_request field, NOT generic prompts (those go to the generic orchestrator)
    if (engineType === "dapr" && !featureRequest) {
      const nodes = workflow.nodes as WorkflowNode[];
      for (const node of nodes) {
        if (node.type === "activity") {
          const data = node.data as Record<string, unknown>;
          const config = (data.config as Record<string, unknown>) || {};
          // Only check for explicit feature_request field (used by planner-agent workflows)
          // Do NOT treat generic AI prompts as feature_request
          if (
            config.feature_request &&
            typeof config.feature_request === "string"
          ) {
            featureRequest = config.feature_request;
          }
          // Check for cwd in activity config
          if (!cwd && config.cwd && typeof config.cwd === "string") {
            cwd = config.cwd;
          }
          if (featureRequest) {
            break; // Found what we need
          }
        }
      }
    }

    if (engineType === "dapr") {
      // Dapr workflow execution - choose between legacy planner or generic orchestrator
      // Get URLs from config service (Azure App Config via Dapr) with fallback to defaults
      const genericUrl = await getGenericOrchestratorUrl();
      const daprUrl = await getDaprOrchestratorUrl();
      const orchestratorUrl =
        ((workflow as Record<string, unknown>).daprOrchestratorUrl as string) ||
        (featureRequest ? daprUrl : genericUrl);

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
        // If we have a feature_request, use the legacy planner-dapr-agent
        if (featureRequest) {
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
        }

        // Otherwise, use the generic TypeScript orchestrator
        const nodes = workflow.nodes as WorkflowNode[];
        const edges = workflow.edges as WorkflowEdge[];

        // Generate workflow definition from the visual graph
        const definition = generateWorkflowDefinition(
          nodes,
          edges,
          workflowId,
          workflow.name,
          {
            description: workflow.description || undefined,
            author: session.user.email || session.user.id,
          }
        );

        // Build per-node connection map from auth templates in node configs
        // Instead of decrypting all connections upfront, we pass connection external IDs
        // per node. The function-router calls the internal decrypt API at execution time
        // to get fresh credentials (with OAuth2 token refresh).
        const nodeConnectionMap: Record<string, string> = {};
        for (const node of nodes) {
          const config =
            ((node.data as Record<string, unknown>)?.config as Record<
              string,
              unknown
            >) || {};
          const authTemplate = config.auth as string | undefined;
          if (authTemplate) {
            const match = authTemplate.match(
              /\{\{connections\[['"]([^'"]+)['"]\]\}\}/
            );
            if (match?.[1]) {
              nodeConnectionMap[node.id] = match[1];
            }
          }
        }

        console.log(
          `[Execute] Built per-node connection map for ${Object.keys(nodeConnectionMap).length} nodes:`,
          Object.keys(nodeConnectionMap)
        );

        // Start workflow via generic orchestrator
        // Credentials are resolved at execution time by function-router via internal decrypt API
        const genericResult = await genericOrchestratorClient.startWorkflow(
          orchestratorUrl,
          definition,
          input,
          {}, // integrations — empty, credentials resolved at function-router
          execution.id, // Database execution ID for logging
          nodeConnectionMap // Per-node connection external IDs
        );

        // Update execution with Dapr instance ID
        await db
          .update(workflowExecutions)
          .set({
            daprInstanceId: genericResult.instanceId,
            phase: "running",
            progress: 0,
          })
          .where(eq(workflowExecutions.id, execution.id));

        return NextResponse.json({
          executionId: execution.id,
          instanceId: genericResult.instanceId,
          daprInstanceId: genericResult.instanceId,
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

    // Validate connection references
    const validation = await validateWorkflowAppConnections(
      workflow.nodes as WorkflowNode[],
      session.user.id
    );
    if (!validation.valid) {
      return NextResponse.json(
        { error: "Workflow contains invalid connection references" },
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
  _userId: string
) {
  try {
    // Execute the workflow
    const result = await executeWorkflow(
      nodes,
      edges,
      executionId,
      workflowId,
      async (nodeId, _status, output) => {
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
        error:
          error instanceof Error ? error.message : "Workflow execution failed",
        completedAt: new Date(),
      })
      .where(eq(workflowExecutions.id, executionId));
  }
}

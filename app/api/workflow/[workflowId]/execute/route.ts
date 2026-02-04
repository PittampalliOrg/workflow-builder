import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getGenericOrchestratorUrl, getDaprOrchestratorUrl } from "@/lib/config-service";
import { db } from "@/lib/db";
import { getIntegrations, validateWorkflowIntegrations } from "@/lib/db/integrations";
import { workflowExecutions, workflowExecutionLogs, workflows } from "@/lib/db/schema";
import { daprClient, genericOrchestratorClient } from "@/lib/dapr-client";
import { generateWorkflowDefinition } from "@/lib/dapr-codegen";
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
    // Only look for explicit feature_request field, NOT generic prompts (those go to the generic orchestrator)
    if (engineType === "dapr" && !featureRequest) {
      const nodes = workflow.nodes as WorkflowNode[];
      for (const node of nodes) {
        if (node.type === "activity") {
          const data = node.data as Record<string, unknown>;
          const config = (data.config as Record<string, unknown>) || {};
          // Only check for explicit feature_request field (used by planner-agent workflows)
          // Do NOT treat generic AI prompts as feature_request
          if (config.feature_request && typeof config.feature_request === "string") {
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
        // If we have a feature_request, use the legacy planner-orchestrator
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

        // Fetch user's integrations and format for the orchestrator
        // Format: { "openai": { "apiKey": "..." }, "slack": { "botToken": "..." } }
        const userIntegrations = await getIntegrations(session.user.id);
        const formattedIntegrations: Record<string, Record<string, string>> = {};

        for (const integration of userIntegrations) {
          // Use integration type as the key (e.g., "openai", "slack", "github")
          const integrationType = integration.type;

          // Convert config values to strings for the orchestrator
          const configEntries: Record<string, string> = {};
          for (const [key, value] of Object.entries(integration.config || {})) {
            if (value !== null && value !== undefined) {
              configEntries[key] = String(value);
            }
          }

          // If there's already an integration of this type, merge configs
          // (user might have multiple openai integrations, use the first one)
          if (!formattedIntegrations[integrationType]) {
            formattedIntegrations[integrationType] = configEntries;
          }
        }

        console.log(
          `[Execute] Passing ${Object.keys(formattedIntegrations).length} integration types to orchestrator:`,
          Object.keys(formattedIntegrations)
        );

        // Start workflow via generic orchestrator
        // Pass the database execution ID so function-runner can log to the correct record
        const genericResult = await genericOrchestratorClient.startWorkflow(
          orchestratorUrl,
          definition,
          input,
          formattedIntegrations,
          execution.id // Database execution ID for logging
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

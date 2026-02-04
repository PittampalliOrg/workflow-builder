/**
 * POST /api/orchestrator/workflows - Start a generic workflow
 *
 * This route starts a workflow using the TypeScript orchestrator.
 * It generates a workflow definition from the stored workflow graph
 * and sends it to the orchestrator service.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { workflows, workflowExecutions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { generateWorkflowDefinition } from "@/lib/dapr-codegen";
import { genericOrchestratorClient } from "@/lib/dapr-client";
import type { WorkflowNode, WorkflowEdge } from "@/lib/workflow-store";

const DEFAULT_ORCHESTRATOR_URL =
  process.env.GENERIC_ORCHESTRATOR_URL ||
  process.env.WORKFLOW_ORCHESTRATOR_URL ||
  "http://workflow-orchestrator:8080";

export async function POST(request: Request) {
  try {
    // Authenticate the request
    const session = await auth.api.getSession({
      headers: await headers(),
    });

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Parse request body
    const body = await request.json();
    const { workflowId, triggerData = {}, integrations = {} } = body;

    if (!workflowId) {
      return NextResponse.json(
        { error: "workflowId is required" },
        { status: 400 }
      );
    }

    // Fetch the workflow from the database
    const [workflow] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, workflowId))
      .limit(1);

    if (!workflow) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    // Check if user has access to this workflow
    if (workflow.userId !== session.user.id && workflow.visibility !== "public") {
      return NextResponse.json(
        { error: "Access denied" },
        { status: 403 }
      );
    }

    // Parse workflow nodes and edges
    const nodes = (workflow.nodes || []) as WorkflowNode[];
    const edges = (workflow.edges || []) as WorkflowEdge[];

    if (nodes.length === 0) {
      return NextResponse.json(
        { error: "Workflow has no nodes" },
        { status: 400 }
      );
    }

    // Generate workflow definition
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

    // Get orchestrator URL
    const orchestratorUrl =
      workflow.daprOrchestratorUrl || DEFAULT_ORCHESTRATOR_URL;

    // Start the workflow
    const result = await genericOrchestratorClient.startWorkflow(
      orchestratorUrl,
      definition,
      triggerData,
      integrations
    );

    // Create execution record in database
    const [execution] = await db
      .insert(workflowExecutions)
      .values({
        workflowId,
        userId: session.user.id,
        status: "running",
        daprInstanceId: result.instanceId,
        phase: "running",
        progress: 0,
        input: triggerData,
      })
      .returning();

    console.log(
      `[Orchestrator API] Started workflow ${workflowId} as instance ${result.instanceId}`
    );

    return NextResponse.json({
      success: true,
      executionId: execution.id,
      instanceId: result.instanceId,
      workflowId,
      status: result.status,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("[Orchestrator API] Error starting workflow:", error);

    return NextResponse.json(
      { error: "Failed to start workflow", message: errorMessage },
      { status: 500 }
    );
  }
}

/**
 * POST /api/orchestrator/workflows - Start a generic workflow
 *
 * This route starts a workflow using the TypeScript orchestrator.
 * It generates a workflow definition from the stored workflow graph
 * and sends it to the orchestrator service.
 */

import { eq, and, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { getOrchestratorUrlAsync } from "@/lib/dapr/config-provider";
import { genericOrchestratorClient } from "@/lib/dapr-client";
import { db } from "@/lib/db";
import { agents, workflowExecutions, workflows } from "@/lib/db/schema";
import type { AgentModelSpec, AgentToolRef } from "@/lib/db/schema";
import { generateWorkflowDefinition } from "@/lib/workflow-definition";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow-store";

/**
 * Resolve saved agent configs for durable/run nodes that have an agentId set.
 * Fetches agent rows from DB and injects `agentConfig` into node config so the
 * orchestrator can forward it to durable-agent without needing DB access.
 */
async function resolveAgentConfigs(
  nodes: WorkflowNode[],
  userId: string,
): Promise<void> {
  // Collect agentIds from durable/run nodes
  const agentIdMap = new Map<string, WorkflowNode[]>();
  for (const node of nodes) {
    const config = (node.data as Record<string, unknown>)?.config as
      | Record<string, unknown>
      | undefined;
    if (!config) continue;
    const actionType = config.actionType as string | undefined;
    const agentId = config.agentId as string | undefined;
    if (actionType === "durable/run" && agentId) {
      const existing = agentIdMap.get(agentId) || [];
      existing.push(node);
      agentIdMap.set(agentId, existing);
    }
  }

  if (agentIdMap.size === 0) return;

  // Batch-fetch agent rows
  const agentIds = [...agentIdMap.keys()];
  const agentRows = await db
    .select({
      id: agents.id,
      name: agents.name,
      instructions: agents.instructions,
      model: agents.model,
      tools: agents.tools,
      maxTurns: agents.maxTurns,
      timeoutMinutes: agents.timeoutMinutes,
    })
    .from(agents)
    .where(
      and(
        inArray(agents.id, agentIds),
        eq(agents.userId, userId),
        eq(agents.isEnabled, true),
      ),
    );

  const agentById = new Map(agentRows.map((a) => [a.id, a]));

  // Inject agentConfig into each matching node
  for (const [agentId, nodeList] of agentIdMap) {
    const agentRow = agentById.get(agentId);
    if (!agentRow) continue;

    const modelSpec = agentRow.model as AgentModelSpec;
    const toolRefs = (agentRow.tools ?? []) as AgentToolRef[];

    const agentConfig = {
      name: agentRow.name,
      instructions: agentRow.instructions,
      modelSpec: `${modelSpec.provider}/${modelSpec.name}`,
      maxTurns: agentRow.maxTurns,
      timeoutMinutes: agentRow.timeoutMinutes,
      tools: toolRefs.map((t) => t.ref),
    };

    for (const node of nodeList) {
      const data = node.data as Record<string, unknown>;
      const config = data.config as Record<string, unknown>;
      config.agentConfig = agentConfig;
    }
  }
}

export async function POST(request: Request) {
  try {
    // Authenticate the request
    const session = await getSession(request);

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
    if (
      workflow.userId !== session.user.id &&
      workflow.visibility !== "public"
    ) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
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

    // Resolve saved agent configs into node data before serialization
    await resolveAgentConfigs(nodes, session.user.id);

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

    // Get orchestrator URL from Dapr config (falls back to env vars)
    const defaultUrl = await getOrchestratorUrlAsync();
    const orchestratorUrl = workflow.daprOrchestratorUrl || defaultUrl;

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

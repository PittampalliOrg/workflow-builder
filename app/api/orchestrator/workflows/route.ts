/**
 * POST /api/orchestrator/workflows - Start a generic workflow
 *
 * This route starts a workflow using the TypeScript orchestrator.
 * It generates a workflow definition from the stored workflow graph
 * and sends it to the orchestrator service.
 */

import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { getOrchestratorUrlAsync } from "@/lib/dapr/config-provider";
import { genericOrchestratorClient } from "@/lib/dapr-client";
import { db } from "@/lib/db";
import { getWorkflowExecutionsSchemaGuardResponse } from "@/lib/db/workflow-executions-schema-guard";
import { appConnections, workflowExecutions, workflows } from "@/lib/db/schema";
import { generateWorkflowDefinition } from "@/lib/workflow-definition";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow-store";

export async function POST(request: Request) {
	try {
		// Authenticate the request
		const session = await getSession(request);

		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const schemaGuardResponse =
			await getWorkflowExecutionsSchemaGuardResponse();
		if (schemaGuardResponse) {
			return schemaGuardResponse;
		}

		// Parse request body
		const body = await request.json();
		const { workflowId, triggerData = {}, integrations = {} } = body;

		if (!workflowId) {
			return NextResponse.json(
				{ error: "workflowId is required" },
				{ status: 400 },
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
				{ status: 404 },
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
				{ status: 400 },
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
			},
		);

		// Get orchestrator URL from Dapr config (falls back to env vars)
		const defaultUrl = await getOrchestratorUrlAsync();
		const orchestratorUrl = workflow.daprOrchestratorUrl || defaultUrl;

		const nodeConnectionMap: Record<string, string> = {};
		const pendingIntegrationIdsByNode = new Map<string, string>();
		for (const node of nodes) {
			const config =
				((node.data as Record<string, unknown>)?.config as Record<
					string,
					unknown
				>) || {};
			const authTemplate = config.auth as string | undefined;
			if (authTemplate) {
				const match = authTemplate.match(
					/\{\{connections\[['"]([^'"]+)['"]\]\}\}/,
				);
				if (match?.[1]) {
					nodeConnectionMap[node.id] = match[1];
					continue;
				}
			}

			const integrationId = config.integrationId as string | undefined;
			if (integrationId && integrationId.trim().length > 0) {
				pendingIntegrationIdsByNode.set(node.id, integrationId.trim());
			}
		}

		if (pendingIntegrationIdsByNode.size > 0) {
			const integrationIds = Array.from(
				new Set(Array.from(pendingIntegrationIdsByNode.values())),
			);
			const rows = await db
				.select({
					id: appConnections.id,
					externalId: appConnections.externalId,
				})
				.from(appConnections)
				.where(
					and(
						eq(appConnections.ownerId, session.user.id),
						inArray(appConnections.id, integrationIds),
					),
				);
			const externalIdByIntegrationId = new Map(
				rows.map((row) => [row.id, row.externalId]),
			);

			for (const [nodeId, integrationId] of pendingIntegrationIdsByNode) {
				if (nodeConnectionMap[nodeId]) {
					continue;
				}
				const externalId = externalIdByIntegrationId.get(integrationId);
				if (externalId) {
					nodeConnectionMap[nodeId] = externalId;
				}
			}
		}

		// Create execution record in database before starting the workflow so
		// runtime actions can use the DB execution ID and per-node connection map.
		const [execution] = await db
			.insert(workflowExecutions)
			.values({
				workflowId,
				userId: session.user.id,
				status: "running",
				phase: "running",
				progress: 0,
				input: triggerData,
			})
			.returning();

		// Start the workflow
		const result = await genericOrchestratorClient.startWorkflow(
			orchestratorUrl,
			definition,
			triggerData,
			integrations,
			execution.id,
			nodeConnectionMap,
		);

		await db
			.update(workflowExecutions)
			.set({
				daprInstanceId: result.instanceId,
				phase: "running",
				progress: 0,
			})
			.where(eq(workflowExecutions.id, execution.id));

		console.log(
			`[Orchestrator API] Started workflow ${workflowId} as instance ${result.instanceId} with ${Object.keys(nodeConnectionMap).length} connection mappings`,
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
			{ status: 500 },
		);
	}
}

import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { getGenericOrchestratorUrl } from "@/lib/config-service";
import { genericOrchestratorClient } from "@/lib/dapr-client";
import { db } from "@/lib/db";
import { validateWorkflowAppConnections } from "@/lib/db/app-connections";
import {
	appConnections,
	workflowExecutionLogs,
	workflowExecutions,
	workflows,
} from "@/lib/db/schema";
import { generateWorkflowDefinition } from "@/lib/workflow-definition";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow-store";

export async function POST(
	request: Request,
	context: { params: Promise<{ workflowId: string }> },
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
				{ status: 404 },
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

		if (engineType === "dapr") {
			// Dapr workflow execution via generic orchestrator
			const orchestratorUrl =
				((workflow as Record<string, unknown>).daprOrchestratorUrl as string) ||
				(await getGenericOrchestratorUrl());

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
					},
				);

				// Build per-node connection map from auth templates in node configs
				// Instead of decrypting all connections upfront, we pass connection external IDs
				// per node. The function-router calls the internal decrypt API at execution time
				// to get fresh credentials (with OAuth2 token refresh).
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

				// Backward-compat: older nodes may only have integrationId set.
				// Resolve integrationId -> externalId so runtime credential fetch still works.
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

				console.log(
					`[Execute] Built per-node connection map for ${Object.keys(nodeConnectionMap).length} nodes:`,
					Object.keys(nodeConnectionMap),
				);

				// Start workflow via generic orchestrator
				// Credentials are resolved at execution time by function-router via internal decrypt API
				const genericResult = await genericOrchestratorClient.startWorkflow(
					orchestratorUrl,
					definition,
					input,
					{}, // integrations — empty, credentials resolved at function-router
					execution.id, // Database execution ID for logging
					nodeConnectionMap, // Per-node connection external IDs
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
					{ status: 502 },
				);
			}
		}

		// Validate connection references
		const validation = await validateWorkflowAppConnections(
			workflow.nodes as WorkflowNode[],
			session.user.id,
		);
		if (!validation.valid) {
			return NextResponse.json(
				{ error: "Workflow contains invalid connection references" },
				{ status: 403 },
			);
		}

		// Non-Dapr workflows are no longer supported
		return NextResponse.json(
			{
				error:
					"Legacy workflow execution is no longer supported. Please set engine type to 'dapr'.",
			},
			{ status: 400 },
		);
	} catch (error) {
		console.error("Failed to start workflow execution:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error ? error.message : "Failed to execute workflow",
			},
			{ status: 500 },
		);
	}
}

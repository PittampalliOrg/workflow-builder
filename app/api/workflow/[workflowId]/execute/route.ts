import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { context, propagation } from "@opentelemetry/api";
import { getSession } from "@/lib/auth-helpers";
import { getGenericOrchestratorUrl } from "@/lib/config-service";
import { genericOrchestratorClient } from "@/lib/dapr-client";
import { db } from "@/lib/db";
import { validateWorkflowAppConnections } from "@/lib/db/app-connections";
import { getWorkflowExecutionsSchemaGuardResponse } from "@/lib/db/workflow-executions-schema-guard";
import {
	appConnections,
	workflowExecutionLogs,
	workflowExecutions,
	workflows,
} from "@/lib/db/schema";
import {
	buildWorkflowExecutionIR,
	WORKFLOW_EXECUTION_IR_VERSION,
} from "@/lib/workflow-contract";
import type { McpInputProperty } from "@/lib/mcp/types";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow-store";

function extractTraceHeaders(request: Request): Record<string, string> {
	const headers: Record<string, string> = {};
	try {
		propagation.inject(context.active(), headers);
	} catch {}
	for (const headerName of ["traceparent", "tracestate", "baggage"] as const) {
		const value = request.headers.get(headerName)?.trim();
		if (value) {
			headers[headerName] = value;
		}
	}
	return headers;
}

function parseManualTriggerInputSchema(
	nodes: WorkflowNode[],
): McpInputProperty[] {
	const triggerNode = nodes.find((node) => node.type === "trigger");
	const config =
		((triggerNode?.data as Record<string, unknown> | undefined)?.config as
			| Record<string, unknown>
			| undefined) ?? {};
	if (config.triggerType !== "Manual") {
		return [];
	}
	if (typeof config.inputSchema !== "string" || !config.inputSchema.trim()) {
		return [];
	}
	try {
		const parsed = JSON.parse(config.inputSchema) as unknown;
		return Array.isArray(parsed)
			? parsed.filter((field): field is McpInputProperty =>
					Boolean(
						field &&
							typeof field === "object" &&
							typeof (field as McpInputProperty).name === "string" &&
							typeof (field as McpInputProperty).type === "string" &&
							typeof (field as McpInputProperty).required === "boolean",
					),
				)
			: [];
	} catch {
		return [];
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateManualTriggerInput(
	schema: McpInputProperty[],
	input: unknown,
): string[] {
	if (schema.length === 0) {
		return [];
	}
	if (!isPlainObject(input)) {
		return ["Execution input must be a JSON object."];
	}

	const errors: string[] = [];
	for (const field of schema) {
		const value = input[field.name];
		const isMissing = value === undefined || value === null || value === "";
		if (field.required && isMissing) {
			errors.push(`Missing required input: ${field.name}`);
			continue;
		}
		if (isMissing) {
			continue;
		}

		const typeValid =
			field.type === "TEXT"
				? typeof value === "string"
				: field.type === "NUMBER"
					? typeof value === "number" && Number.isFinite(value)
					: field.type === "BOOLEAN"
						? typeof value === "boolean"
						: field.type === "DATE"
							? (typeof value === "string" &&
									!Number.isNaN(Date.parse(value))) ||
								value instanceof Date
							: field.type === "ARRAY"
								? Array.isArray(value)
								: isPlainObject(value);

		if (!typeValid) {
			errors.push(
				`Input ${field.name} must be of type ${field.type.toLowerCase()}.`,
			);
		}
	}

	return errors;
}

function normalizeExecutionInput(
	workflowId: string,
	input: unknown,
): Record<string, unknown> {
	if (!isPlainObject(input)) {
		return {};
	}
	if (workflowId === "aicodingagent001" && typeof input.branch !== "string") {
		return {
			...input,
			branch: "main",
		};
	}
	return input;
}

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

		const schemaGuardResponse =
			await getWorkflowExecutionsSchemaGuardResponse();
		if (schemaGuardResponse) {
			return schemaGuardResponse;
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
		const input = normalizeExecutionInput(workflowId, body.input);

		// Route based on engine type
		const engineType = (workflow as Record<string, unknown>).engineType as
			| string
			| undefined;

		if (engineType === "dapr") {
			// Dapr workflow execution via generic orchestrator
			const orchestratorUrl =
				((workflow as Record<string, unknown>).daprOrchestratorUrl as string) ||
				(await getGenericOrchestratorUrl());
			const nodes = workflow.nodes as WorkflowNode[];
			const edges = workflow.edges as WorkflowEdge[];
			const manualTriggerInputSchema = parseManualTriggerInputSchema(nodes);
			const inputValidationErrors = validateManualTriggerInput(
				manualTriggerInputSchema,
				input,
			);
			if (inputValidationErrors.length > 0) {
				return NextResponse.json(
					{
						error: "Invalid workflow input",
						details: inputValidationErrors,
					},
					{ status: 400 },
				);
			}

			const executionIr = buildWorkflowExecutionIR({
				workflowId,
				name: workflow.name,
				description: workflow.description || undefined,
				author: session.user.email || session.user.id,
				nodes,
				edges,
				spec: (workflow as Record<string, unknown>).spec,
				specVersion:
					((workflow as Record<string, unknown>).specVersion as
						| string
						| null
						| undefined) ?? null,
			});

			// Create execution record
			const [execution] = await db
				.insert(workflowExecutions)
				.values({
					workflowId,
					userId: session.user.id,
					status: "running",
					input,
					executionIrVersion: WORKFLOW_EXECUTION_IR_VERSION,
					executionIr,
				})
				.returning();

			try {
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
					executionIr.definition,
					input,
					{}, // integrations — empty, credentials resolved at function-router
					execution.id, // Database execution ID for logging
					nodeConnectionMap, // Per-node connection external IDs
					undefined,
					extractTraceHeaders(request),
				);

				// Update execution with Dapr instance ID
				await db
					.update(workflowExecutions)
					.set({
						daprInstanceId: genericResult.instanceId,
						phase: "running",
						progress: 0,
						executionIrVersion: WORKFLOW_EXECUTION_IR_VERSION,
						executionIr,
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

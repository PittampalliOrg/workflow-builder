import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { context, propagation } from "@opentelemetry/api";
import { getSession } from "@/lib/auth-helpers";
import { getGenericOrchestratorUrl } from "@/lib/config-service";
import { db } from "@/lib/db";
import { getWorkflowExecutionsSchemaGuardResponse } from "@/lib/db/workflow-executions-schema-guard";
import { workflowExecutions, workflows } from "@/lib/db/schema";
import {
	isSupportedWorkflowId,
	normalizeWorkflowToSwCutover,
} from "@/lib/serverless-workflow/cutover";
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeExecutionInput(
	workflowId: string,
	input: unknown,
): Record<string, unknown> {
	if (!isPlainObject(input)) {
		return {};
	}
	return input;
}

/**
 * Execute a workflow via the CNCF Serverless Workflow 1.0 interpreter.
 *
 * All workflows are compiled to SW 1.0 format and executed via the
 * sw_workflow_v1 Dapr workflow interpreter. Legacy dynamic_workflow
 * is no longer used for new executions.
 */
export async function POST(
	request: Request,
	context: { params: Promise<{ workflowId: string }> },
) {
	try {
		const { workflowId } = await context.params;
		if (!isSupportedWorkflowId(workflowId)) {
			return NextResponse.json(
				{ error: "Workflow not found" },
				{ status: 404 },
			);
		}

		const session = await getSession(request);
		if (!session) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const schemaGuardResponse =
			await getWorkflowExecutionsSchemaGuardResponse();
		if (schemaGuardResponse) {
			return schemaGuardResponse;
		}

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

		const body = await request.json().catch(() => ({}));
		const input = normalizeExecutionInput(workflowId, body.input);

		const orchestratorUrl =
			((workflow as Record<string, unknown>).daprOrchestratorUrl as string) ||
			(await getGenericOrchestratorUrl());
		const normalized = normalizeWorkflowToSwCutover({
			name: workflow.name,
			description: workflow.description ?? undefined,
			nodes: workflow.nodes as WorkflowNode[],
			edges: workflow.edges as WorkflowEdge[],
			spec: (workflow as Record<string, unknown>).spec,
			specVersion:
				((workflow as Record<string, unknown>).specVersion as
					| string
					| null
					| undefined) ?? null,
		});
		if (normalized.needsMigration) {
			await db
				.update(workflows)
				.set({
					nodes: normalized.nodes,
					edges: normalized.edges,
					specVersion: normalized.specVersion,
					spec: normalized.spec,
					updatedAt: new Date(),
				})
				.where(eq(workflows.id, workflow.id));
		}

		// Create execution record
		const [execution] = await db
			.insert(workflowExecutions)
			.values({
				workflowId,
				userId: session.user.id,
				status: "running",
				input,
				executionIrVersion: "sw-1.0.0",
			})
			.returning();

		try {
			// Submit to the sw_workflow_v1 interpreter via Dapr service invocation.
			// Using the local Dapr sidecar (localhost:3500) preserves W3C trace context
			// end-to-end, ensuring workflow spans appear under the caller's trace in Tempo.
			const daprPort = process.env.DAPR_HTTP_PORT || "3500";
			const swResponse = await fetch(
				`http://localhost:${daprPort}/v1.0/invoke/workflow-orchestrator/method/api/v2/sw-workflows`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...extractTraceHeaders(request),
					},
					body: JSON.stringify({
						workflow: normalized.spec,
						triggerData: input,
						dbExecutionId: execution.id,
					}),
				},
			);

			if (!swResponse.ok) {
				const errorText = await swResponse.text().catch(() => "Unknown error");
				throw new Error(
					`SW workflow failed: ${swResponse.status} ${errorText}`,
				);
			}

			const swResult = await swResponse.json();

			await db
				.update(workflowExecutions)
				.set({
					daprInstanceId: swResult.instanceId,
					phase: "running",
					progress: 0,
				})
				.where(eq(workflowExecutions.id, execution.id));

			return NextResponse.json({
				executionId: execution.id,
				instanceId: swResult.instanceId,
				daprInstanceId: swResult.instanceId,
				status: "running",
			});
		} catch (swError) {
			await db
				.update(workflowExecutions)
				.set({
					status: "error",
					error:
						swError instanceof Error
							? swError.message
							: "Failed to start SW workflow",
					completedAt: new Date(),
				})
				.where(eq(workflowExecutions.id, execution.id));

			return NextResponse.json(
				{
					error:
						swError instanceof Error
							? swError.message
							: "Failed to start SW workflow",
				},
				{ status: 502 },
			);
		}
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

import { eq } from "drizzle-orm";
import { context, propagation } from "@opentelemetry/api";
import { db } from "@/lib/db";
import type { Workflow as DbWorkflow } from "@/lib/db/schema";
import { workflowExecutions, workflows } from "@/lib/db/schema";
import {
	normalizeWorkflowToSwCutover,
	validateSupportedWorkflowTriggerInput,
} from "@/lib/serverless-workflow/cutover";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow-store";

export class StartSupportedWorkflowExecutionError extends Error {
	status: number;
	issues?: string[];

	constructor(message: string, status: number, issues?: string[]) {
		super(message);
		this.name = "StartSupportedWorkflowExecutionError";
		this.status = status;
		this.issues = issues;
	}
}

type StartableWorkflow = Pick<
	DbWorkflow,
	| "id"
	| "name"
	| "description"
	| "nodes"
	| "edges"
	| "spec"
	| "specVersion"
	| "userId"
>;

type StartParams = {
	request?: Request;
	workflow: StartableWorkflow;
	input: Record<string, unknown>;
};

type StartResult = {
	executionId: string;
	instanceId: string;
	daprInstanceId: string;
	status: "running";
};

function extractTraceHeaders(request?: Request): Record<string, string> {
	const headers: Record<string, string> = {};
	try {
		propagation.inject(context.active(), headers);
	} catch {}
	if (!request) {
		return headers;
	}
	for (const headerName of ["traceparent", "tracestate", "baggage"] as const) {
		const value = request.headers.get(headerName)?.trim();
		if (value) {
			headers[headerName] = value;
		}
	}
	return headers;
}

export async function startSupportedWorkflowExecution({
	request,
	workflow,
	input,
}: StartParams): Promise<StartResult> {
	const inputIssues = validateSupportedWorkflowTriggerInput(input);
	if (inputIssues.length > 0) {
		throw new StartSupportedWorkflowExecutionError(
			"Invalid workflow input",
			400,
			inputIssues,
		);
	}

	let normalized;
	try {
		normalized = normalizeWorkflowToSwCutover({
			workflowId: workflow.id,
			name: workflow.name,
			description: workflow.description ?? undefined,
			nodes: workflow.nodes as WorkflowNode[],
			edges: workflow.edges as WorkflowEdge[],
			spec: workflow.spec,
			specVersion: workflow.specVersion ?? null,
		});
	} catch (error) {
		throw new StartSupportedWorkflowExecutionError(
			error instanceof Error ? error.message : "Invalid workflow definition",
			400,
		);
	}

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

	const [execution] = await db
		.insert(workflowExecutions)
		.values({
			workflowId: workflow.id,
			userId: workflow.userId,
			status: "running",
			input,
			executionIrVersion: "sw-1.0.0",
		})
		.returning();

	try {
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
			throw new Error(`SW workflow failed: ${swResponse.status} ${errorText}`);
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

		return {
			executionId: execution.id,
			instanceId: swResult.instanceId,
			daprInstanceId: swResult.instanceId,
			status: "running",
		};
	} catch (error) {
		await db
			.update(workflowExecutions)
			.set({
				status: "error",
				error:
					error instanceof Error
						? error.message
						: "Failed to start SW workflow",
				completedAt: new Date(),
			})
			.where(eq(workflowExecutions.id, execution.id));

		throw new StartSupportedWorkflowExecutionError(
			error instanceof Error ? error.message : "Failed to start SW workflow",
			502,
		);
	}
}

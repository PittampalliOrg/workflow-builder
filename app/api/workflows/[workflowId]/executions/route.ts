import { and, desc, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { getGenericOrchestratorUrl } from "@/lib/config-service";
import { genericOrchestratorClient } from "@/lib/dapr-client";
import { db } from "@/lib/db";
import { getWorkflowExecutionsSchemaGuardResponse } from "@/lib/db/workflow-executions-schema-guard";
import {
	workflowAgentRuns,
	workflowExecutionLogs,
	workflowExecutions,
	workflowExternalEvents,
	workflowPlanArtifacts,
	workflows,
} from "@/lib/db/schema";
import { mapRuntimeStatusToLocalStatus } from "@/lib/transforms/durable-timeline";

export async function GET(
	request: Request,
	context: { params: Promise<{ workflowId: string }> },
) {
	try {
		const { workflowId } = await context.params;
		const session = await getSession(request);

		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const schemaGuardResponse =
			await getWorkflowExecutionsSchemaGuardResponse();
		if (schemaGuardResponse) {
			return schemaGuardResponse;
		}

		const workflow = await db.query.workflows.findFirst({
			where: and(
				eq(workflows.id, workflowId),
				eq(workflows.userId, session.user.id),
			),
		});

		if (!workflow) {
			return NextResponse.json(
				{ error: "Workflow not found" },
				{ status: 404 },
			);
		}

		const executions = await db.query.workflowExecutions.findMany({
			where: eq(workflowExecutions.workflowId, workflowId),
			orderBy: [desc(workflowExecutions.startedAt)],
			limit: 50,
		});

		const executionIds = executions.map((execution) => execution.id);
		const [agentRunRows, logChildRows, artifactRows, eventRows] =
			executionIds.length > 0
				? await Promise.all([
						db
							.select({
								workflowExecutionId: workflowAgentRuns.workflowExecutionId,
							})
							.from(workflowAgentRuns)
							.where(
								inArray(workflowAgentRuns.workflowExecutionId, executionIds),
							),
						db
							.select({
								executionId: workflowExecutionLogs.executionId,
							})
							.from(workflowExecutionLogs)
							.where(
								and(
									inArray(workflowExecutionLogs.executionId, executionIds),
									inArray(workflowExecutionLogs.activityName, [
										"durable/run",
										"durable/claude-plan",
										"durable/plan",
										"durable/execute-plan",
										"mastra/execute",
									]),
								),
							),
						db
							.select({
								workflowExecutionId: workflowPlanArtifacts.workflowExecutionId,
							})
							.from(workflowPlanArtifacts)
							.where(
								inArray(
									workflowPlanArtifacts.workflowExecutionId,
									executionIds,
								),
							),
						db
							.select({ executionId: workflowExternalEvents.executionId })
							.from(workflowExternalEvents)
							.where(inArray(workflowExternalEvents.executionId, executionIds)),
					])
				: [[], [], [], []];

		const hasChildRuns = new Set(
			[
				...agentRunRows.map((row) => row.workflowExecutionId),
				...logChildRows.map((row) => row.executionId),
			].filter(Boolean),
		);
		const hasPlanArtifacts = new Set(
			artifactRows.map((row) => row.workflowExecutionId),
		);
		const hasExternalEvents = new Set(eventRows.map((row) => row.executionId));

		const runtimeByExecution = new Map<
			string,
			Awaited<ReturnType<typeof genericOrchestratorClient.getWorkflowStatus>>
		>();
		const activeWithRuntime = executions.filter(
			(execution) =>
				execution.daprInstanceId &&
				(execution.status === "running" || execution.status === "pending"),
		);
		if (activeWithRuntime.length > 0) {
			const orchestratorUrl =
				workflow.daprOrchestratorUrl || (await getGenericOrchestratorUrl());
			const runtimeResults = await Promise.allSettled(
				activeWithRuntime.map(async (execution) => {
					const runtime = await genericOrchestratorClient.getWorkflowStatus(
						orchestratorUrl,
						execution.daprInstanceId as string,
					);
					return { executionId: execution.id, runtime };
				}),
			);
			for (const result of runtimeResults) {
				if (result.status === "fulfilled") {
					runtimeByExecution.set(
						result.value.executionId,
						result.value.runtime,
					);
				}
			}
		}

		const enriched = executions.map((execution) => {
			const runtime = runtimeByExecution.get(execution.id) ?? null;
			const mapped = runtime
				? mapRuntimeStatusToLocalStatus({
						runtimeStatus: runtime.runtimeStatus,
						phase: runtime.phase,
						message: runtime.message,
						outputs: runtime.outputs,
						error: runtime.error,
						fallbackStatus: execution.status,
					})
				: null;
			const status = mapped?.status ?? execution.status;
			return {
				...execution,
				status,
				daprWorkflowVersion: runtime?.workflowVersion ?? null,
				phase: runtime?.phase ?? execution.phase,
				progress: runtime?.progress ?? execution.progress,
				runtimeStatus: runtime?.runtimeStatus ?? null,
				currentNodeName: runtime?.currentNodeName ?? null,
				approvalEventName: runtime?.approvalEventName ?? null,
				statusDiverged:
					(mapped ? mapped.status !== execution.status : false) ||
					(runtime ? runtime.phase !== execution.phase : false),
				hasChildRuns: hasChildRuns.has(execution.id),
				hasPlanArtifacts: hasPlanArtifacts.has(execution.id),
				hasExternalEvents: hasExternalEvents.has(execution.id),
			};
		});

		return NextResponse.json(enriched);
	} catch (error) {
		console.error("Failed to get executions:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error ? error.message : "Failed to get executions",
			},
			{ status: 500 },
		);
	}
}

export async function DELETE(
	request: Request,
	context: { params: Promise<{ workflowId: string }> },
) {
	try {
		const { workflowId } = await context.params;
		const session = await getSession(request);

		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const schemaGuardResponse =
			await getWorkflowExecutionsSchemaGuardResponse();
		if (schemaGuardResponse) {
			return schemaGuardResponse;
		}

		// Verify workflow ownership
		const workflow = await db.query.workflows.findFirst({
			where: and(
				eq(workflows.id, workflowId),
				eq(workflows.userId, session.user.id),
			),
		});

		if (!workflow) {
			return NextResponse.json(
				{ error: "Workflow not found" },
				{ status: 404 },
			);
		}

		// Get all execution IDs for this workflow
		const executions = await db.query.workflowExecutions.findMany({
			where: eq(workflowExecutions.workflowId, workflowId),
			columns: { id: true },
		});

		const executionIds = executions.map((e) => e.id);

		// Delete logs first (if there are any executions)
		if (executionIds.length > 0) {
			const { workflowExecutionLogs } = await import("@/lib/db/schema");

			await db
				.delete(workflowExecutionLogs)
				.where(inArray(workflowExecutionLogs.executionId, executionIds));

			// Then delete the executions
			await db
				.delete(workflowExecutions)
				.where(eq(workflowExecutions.workflowId, workflowId));
		}

		return NextResponse.json({
			success: true,
			deletedCount: executionIds.length,
		});
	} catch (error) {
		console.error("Failed to delete executions:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to delete executions",
			},
			{ status: 500 },
		);
	}
}

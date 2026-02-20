import { asc, eq, or } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { getWorkflowOrchestratorUrl } from "@/lib/config-service";
import { genericOrchestratorClient } from "@/lib/dapr-client";
import { db } from "@/lib/db";
import {
	workflowExecutionLogs,
	workflowExecutions,
	workflows,
} from "@/lib/db/schema";
import {
	calculateDuration,
	mapExecutionLogsToEvents,
	mapWorkflowStatus,
	toWorkflowDetail,
} from "@/lib/transforms/workflow-ui";
import type {
	DaprExecutionEvent,
	WorkflowDetail,
	WorkflowPhase,
} from "@/lib/types/workflow-ui";

export const dynamic = "force-dynamic";

function toWorkflowPhase(phase: string | undefined): WorkflowPhase | undefined {
	if (!phase) return undefined;
	if (phase === "clone") return phase;
	if (phase === "exploration") return phase;
	if (phase === "planning") return phase;
	if (phase === "awaiting_approval") return phase;
	if (phase === "executing") return phase;
	if (phase === "completed") return phase;
	if (phase === "failed") return phase;
	return undefined;
}

function mapHistoryEventType(eventType: string): DaprExecutionEvent["eventType"] {
	if (eventType === "ExecutionCompleted") return eventType;
	if (eventType === "OrchestratorStarted") return eventType;
	if (eventType === "TaskCompleted") return eventType;
	if (eventType === "TaskScheduled") return eventType;
	if (eventType === "EventRaised") return eventType;
	return "TaskCompleted";
}

function toExecutionHistoryEvent(
	event: Awaited<
		ReturnType<typeof genericOrchestratorClient.getWorkflowHistory>
	>["events"][number],
): DaprExecutionEvent {
	return {
		eventId: typeof event.eventId === "number" ? event.eventId : null,
		eventType: mapHistoryEventType(event.eventType),
		name: typeof event.name === "string" ? event.name : null,
		timestamp:
			typeof event.timestamp === "string"
				? event.timestamp
				: new Date().toISOString(),
		input: event.input,
		output: event.output,
		metadata:
			event.metadata && typeof event.metadata === "object"
				? {
						status:
							typeof event.metadata.status === "string"
								? event.metadata.status
								: undefined,
						taskId:
							typeof event.metadata.taskId === "string"
								? event.metadata.taskId
								: undefined,
					}
				: undefined,
	};
}

/**
 * GET /api/monitor/[instanceId]
 * Dapr-first detail endpoint with DB enrichment/fallback.
 */
export async function GET(
	_request: NextRequest,
	{ params }: { params: Promise<{ instanceId: string }> },
) {
	try {
		const { instanceId } = await params;

		const [dbResult] = await db
			.select({
				execution: workflowExecutions,
				workflow: workflows,
			})
			.from(workflowExecutions)
			.innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
			.where(
				or(
					eq(workflowExecutions.id, instanceId),
					eq(workflowExecutions.daprInstanceId, instanceId),
				),
			)
			.limit(1);

		const logs = dbResult
			? await db
					.select()
					.from(workflowExecutionLogs)
					.where(eq(workflowExecutionLogs.executionId, dbResult.execution.id))
					.orderBy(asc(workflowExecutionLogs.timestamp))
			: [];

		const daprInstanceId = dbResult?.execution.daprInstanceId || instanceId;
		let daprStatus:
			| Awaited<ReturnType<typeof genericOrchestratorClient.getWorkflowStatus>>
			| null = null;
		let daprHistory:
			| Awaited<ReturnType<typeof genericOrchestratorClient.getWorkflowHistory>>
			| null = null;

		try {
			const orchestratorUrl = await getWorkflowOrchestratorUrl();
			daprStatus = await genericOrchestratorClient.getWorkflowStatus(
				orchestratorUrl,
				daprInstanceId,
			);
			daprHistory = await genericOrchestratorClient.getWorkflowHistory(
				orchestratorUrl,
				daprInstanceId,
			);
		} catch (error) {
			console.warn(
				`[Monitor] Failed to fetch Dapr status/history for ${daprInstanceId}:`,
				error,
			);
		}

		if (!dbResult && !daprStatus) {
			return NextResponse.json(
				{ error: "Workflow execution not found" },
				{ status: 404 },
			);
		}

		if (daprStatus) {
			const startTime =
				daprStatus.startedAt ||
				(dbResult ? new Date(dbResult.execution.startedAt).toISOString() : null) ||
				new Date().toISOString();
			const endTime =
				daprStatus.completedAt ||
				(dbResult?.execution.completedAt
					? new Date(dbResult.execution.completedAt).toISOString()
					: null);
			const phase = toWorkflowPhase(daprStatus.phase);
			const history =
				daprHistory?.events?.map(toExecutionHistoryEvent) ||
				(dbResult
					? mapExecutionLogsToEvents(
							logs,
							dbResult.execution.startedAt,
							dbResult.execution.completedAt,
							dbResult.execution.status,
							dbResult.execution.input,
						)
					: []);

			const detail: WorkflowDetail = {
				instanceId: daprStatus.instanceId,
				workflowType:
					daprStatus.workflowName || daprStatus.workflowId || "workflow",
				appId: "workflow-orchestrator",
				status: mapWorkflowStatus(daprStatus.runtimeStatus),
				startTime,
				endTime,
				customStatus:
					phase ||
					daprStatus.progress !== undefined ||
					daprStatus.message ||
					daprStatus.currentNodeName
						? {
								phase: phase || "executing",
								progress: daprStatus.progress ?? 0,
								message: daprStatus.message || "",
								currentTask: daprStatus.currentNodeName || undefined,
							}
						: undefined,
				workflowName: dbResult?.workflow.name || daprStatus.workflowName || undefined,
				executionDuration: calculateDuration(startTime, endTime),
				input: dbResult?.execution.input || {},
				output: daprStatus.outputs || dbResult?.execution.output || {},
				executionHistory: history,
				daprStatus: {
					runtimeStatus: daprStatus.runtimeStatus as
						| "RUNNING"
						| "COMPLETED"
						| "FAILED"
						| "CANCELED"
						| "TERMINATED"
						| "PENDING"
						| "SUSPENDED"
						| "STALLED"
						| "UNKNOWN",
					phase: daprStatus.phase,
					progress: daprStatus.progress,
					message: daprStatus.message,
					currentNodeId: daprStatus.currentNodeId,
					currentNodeName: daprStatus.currentNodeName,
					error: daprStatus.error,
				},
			};
			return NextResponse.json(detail);
		}

		const fallback = toWorkflowDetail(dbResult!.execution, dbResult!.workflow, logs);
		return NextResponse.json(fallback);
	} catch (error) {
		console.error("Error fetching workflow execution detail:", error);
		return NextResponse.json(
			{ error: "Failed to fetch workflow execution detail" },
			{ status: 500 },
		);
	}
}

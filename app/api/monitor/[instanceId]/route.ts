import { asc, eq, or } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { getWorkflowOrchestratorUrl } from "@/lib/config-service";
import { genericOrchestratorClient } from "@/lib/dapr-client";
import { db } from "@/lib/db";
import { getWorkflowExecutionsSchemaGuardResponse } from "@/lib/db/workflow-executions-schema-guard";
import { buildWorkflowRuntimeGraph } from "@/lib/workflow-runtime-graph";
import {
	workflowAgentRuns,
	workflowExecutionLogs,
	workflowExecutions,
	workflowExternalEvents,
	workflowPlanArtifacts,
	workflows,
} from "@/lib/db/schema";
import {
	calculateDuration,
	mapExecutionLogsToEvents,
	mapWorkflowStatus,
	toWorkflowDetail,
} from "@/lib/transforms/workflow-ui";
import {
	buildDurableTimeline,
	buildExecutionConsistency,
	toDurableAgentRunSummary,
	toDurableExternalEventSummary,
	toDurablePlanArtifactSummary,
	toDurableRuntimeSnapshot,
} from "@/lib/transforms/durable-timeline";
import type { DurableTimelineEvent } from "@/lib/types/durable-timeline";
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

function mapHistoryEventType(
	eventType: string,
): DaprExecutionEvent["eventType"] {
	if (eventType === "ExecutionCompleted") return eventType;
	if (eventType === "OrchestratorStarted") return eventType;
	if (eventType === "TaskCompleted") return eventType;
	if (eventType === "TaskScheduled") return eventType;
	if (eventType === "EventRaised") return eventType;
	return eventType || "TaskCompleted";
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
						error:
							typeof event.metadata.error === "string"
								? event.metadata.error
								: undefined,
						stackTrace:
							typeof event.metadata.stackTrace === "string"
								? event.metadata.stackTrace
								: undefined,
						version:
							typeof event.metadata.version === "string"
								? event.metadata.version
								: undefined,
						rerunSourceInstanceId:
							typeof event.metadata.rerunSourceInstanceId === "string"
								? event.metadata.rerunSourceInstanceId
								: undefined,
					}
				: undefined,
	};
}

function mapTimelineToExecutionHistory(
	timeline: DurableTimelineEvent[],
): DaprExecutionEvent[] {
	return timeline.map((event, index) => ({
		eventId: index + 1,
		eventType: event.kind,
		name: event.nodeName ?? event.label,
		timestamp: event.ts,
		input: event.input,
		output: event.output,
		metadata: {
			status: event.status ?? undefined,
			taskId: event.nodeId ?? undefined,
			elapsed:
				typeof event.durationMs === "number"
					? `${event.durationMs}ms`
					: undefined,
			durationMs: event.durationMs ?? undefined,
			source: event.source,
			nodeId: event.nodeId ?? undefined,
			nodeName: event.nodeName ?? undefined,
			activityName: event.activityName ?? undefined,
		},
	}));
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

		const schemaGuardResponse =
			await getWorkflowExecutionsSchemaGuardResponse();
		if (schemaGuardResponse) {
			return schemaGuardResponse;
		}

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
		const [externalEvents, planArtifacts, agentRuns] = dbResult
			? await Promise.all([
					db
						.select()
						.from(workflowExternalEvents)
						.where(
							eq(workflowExternalEvents.executionId, dbResult.execution.id),
						)
						.orderBy(asc(workflowExternalEvents.createdAt)),
					db
						.select()
						.from(workflowPlanArtifacts)
						.where(
							eq(
								workflowPlanArtifacts.workflowExecutionId,
								dbResult.execution.id,
							),
						)
						.orderBy(asc(workflowPlanArtifacts.createdAt)),
					db
						.select()
						.from(workflowAgentRuns)
						.where(
							eq(workflowAgentRuns.workflowExecutionId, dbResult.execution.id),
						)
						.orderBy(asc(workflowAgentRuns.createdAt)),
				])
			: [[], [], []];

		const daprInstanceId = dbResult?.execution.daprInstanceId || instanceId;
		let daprStatus: Awaited<
			ReturnType<typeof genericOrchestratorClient.getWorkflowStatus>
		> | null = null;
		let daprHistory: Awaited<
			ReturnType<typeof genericOrchestratorClient.getWorkflowHistory>
		> | null = null;

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
				(dbResult
					? new Date(dbResult.execution.startedAt).toISOString()
					: null) ||
				new Date().toISOString();
			const endTime =
				daprStatus.completedAt ||
				(dbResult?.execution.completedAt
					? new Date(dbResult.execution.completedAt).toISOString()
					: null);
			const phase = toWorkflowPhase(daprStatus.phase);
			const runtime = toDurableRuntimeSnapshot(daprStatus);
			const timeline =
				dbResult &&
				buildDurableTimeline({
					execution: dbResult.execution,
					orchestratorHistory: daprHistory?.events ?? [],
					logs,
					externalEvents,
					planArtifacts,
					agentRuns,
				});
			const history = timeline
				? mapTimelineToExecutionHistory(timeline)
				: daprHistory?.events?.map(toExecutionHistoryEvent) ||
					(dbResult
						? mapExecutionLogsToEvents(
								logs,
								dbResult.execution.startedAt,
								dbResult.execution.completedAt,
								dbResult.execution.status,
								dbResult.execution.input,
							)
						: []);
			const consistency =
				dbResult &&
				buildExecutionConsistency({
					dbStatus: dbResult.execution.status,
					dbPhase: dbResult.execution.phase,
					runtime,
				});

			const detail: WorkflowDetail = {
				executionId: dbResult?.execution.id,
				instanceId: daprStatus.instanceId,
				daprInstanceId: daprStatus.instanceId,
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
				workflowName:
					dbResult?.workflow.name || daprStatus.workflowName || undefined,
				workflowVersion: daprStatus.workflowVersion ?? null,
				workflowNameVersioned: daprStatus.workflowNameVersioned ?? null,
				executionDuration: calculateDuration(startTime, endTime),
				input: dbResult?.execution.input || {},
				output: daprStatus.outputs || dbResult?.execution.output || {},
				graph:
					dbResult?.workflow.nodes && dbResult.workflow.edges
						? buildWorkflowRuntimeGraph({
								nodes: dbResult.workflow.nodes as any,
								edges: dbResult.workflow.edges as any,
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
									stackTrace: daprStatus.stackTrace ?? null,
									parentInstanceId: daprStatus.parentInstanceId ?? null,
								},
							})
						: undefined,
				error: daprStatus.error || dbResult?.execution.error || null,
				errorStackTrace:
					daprStatus.stackTrace ?? dbResult?.execution.errorStackTrace ?? null,
				rerunOfExecutionId: dbResult?.execution.rerunOfExecutionId ?? null,
				rerunSourceInstanceId:
					dbResult?.execution.rerunSourceInstanceId ?? null,
				rerunFromEventId: dbResult?.execution.rerunFromEventId ?? null,
				executionHistory: history,
				timeline: timeline ?? undefined,
				agentRuns:
					dbResult && agentRuns.length > 0
						? toDurableAgentRunSummary(agentRuns)
						: [],
				externalEvents:
					dbResult && externalEvents.length > 0
						? toDurableExternalEventSummary(externalEvents)
						: [],
				planArtifacts:
					dbResult && planArtifacts.length > 0
						? toDurablePlanArtifactSummary(planArtifacts)
						: [],
				consistency: consistency ?? undefined,
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
					stackTrace: daprStatus.stackTrace ?? null,
					parentInstanceId: daprStatus.parentInstanceId ?? null,
				},
			};
			return NextResponse.json(detail);
		}

		const fallback = toWorkflowDetail(
			dbResult!.execution,
			dbResult!.workflow,
			logs,
		);
		const fallbackTimeline = buildDurableTimeline({
			execution: dbResult!.execution,
			orchestratorHistory: [],
			logs,
			externalEvents,
			planArtifacts,
			agentRuns,
		});
		fallback.timeline = fallbackTimeline;
		fallback.executionHistory = mapTimelineToExecutionHistory(fallbackTimeline);
		fallback.graph = buildWorkflowRuntimeGraph({
			nodes: dbResult!.workflow.nodes as any,
			edges: dbResult!.workflow.edges as any,
			executionHistory: fallback.executionHistory,
			daprStatus: fallback.daprStatus,
		});
		fallback.agentRuns = toDurableAgentRunSummary(agentRuns);
		fallback.externalEvents = toDurableExternalEventSummary(externalEvents);
		fallback.planArtifacts = toDurablePlanArtifactSummary(planArtifacts);
		fallback.consistency = buildExecutionConsistency({
			dbStatus: dbResult!.execution.status,
			dbPhase: dbResult!.execution.phase,
			runtime: null,
		});
		fallback.error = dbResult!.execution.error;
		fallback.errorStackTrace = dbResult!.execution.errorStackTrace ?? null;
		fallback.rerunOfExecutionId =
			dbResult!.execution.rerunOfExecutionId ?? null;
		fallback.rerunSourceInstanceId =
			dbResult!.execution.rerunSourceInstanceId ?? null;
		fallback.rerunFromEventId = dbResult!.execution.rerunFromEventId ?? null;
		return NextResponse.json(fallback);
	} catch (error) {
		console.error("Error fetching workflow execution detail:", error);
		return NextResponse.json(
			{ error: "Failed to fetch workflow execution detail" },
			{ status: 500 },
		);
	}
}

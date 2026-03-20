import { asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { getGenericOrchestratorUrl } from "@/lib/config-service";
import { genericOrchestratorClient } from "@/lib/dapr-client";
import { db } from "@/lib/db";
import {
	workflowAgentRuns,
	workflowExecutionLogs,
	workflowExecutions,
	workflowExternalEvents,
	workflowPlanArtifacts,
} from "@/lib/db/schema";
import {
	buildAgentNodeProgress,
	buildDurableTimeline,
	buildExecutionConsistency,
	deriveDurableAgentRuns,
	toDurableAgentRunSummary,
	toDurableExternalEventSummary,
	toDurablePlanArtifactSummary,
	toDurableRuntimeSnapshot,
} from "@/lib/transforms/durable-timeline";
import { redactSensitiveData } from "@/lib/utils/redact";

const DAPR_AGENT_RUNTIME_API_BASE_URL =
	process.env.DAPR_AGENT_RUNTIME_API_BASE_URL ||
	"http://dapr-agent-runtime.workflow-builder.svc.cluster.local:8082";

function getNodeActionTypeMap(nodes: unknown): Map<string, string> {
	const result = new Map<string, string>();
	if (!Array.isArray(nodes)) {
		return result;
	}
	for (const node of nodes) {
		if (!node || typeof node !== "object") {
			continue;
		}
		const record = node as Record<string, unknown>;
		const nodeId = typeof record.id === "string" ? record.id : null;
		const data =
			record.data && typeof record.data === "object"
				? (record.data as Record<string, unknown>)
				: null;
		const config =
			data?.config && typeof data.config === "object"
				? (data.config as Record<string, unknown>)
				: null;
		const actionType =
			config && typeof config.actionType === "string"
				? config.actionType
				: null;
		if (nodeId && actionType) {
			result.set(nodeId, actionType);
		}
	}
	return result;
}

async function fetchAgentLivePayload(
	actionType: string | undefined,
	instanceId: string,
): Promise<Record<string, unknown> | null> {
	if (actionType !== "dapr-agent/run") {
		return null;
	}
	const response = await fetch(
		`${DAPR_AGENT_RUNTIME_API_BASE_URL.replace(/\/+$/, "")}/api/run/${encodeURIComponent(instanceId)}`,
		{
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(4000),
			cache: "no-store",
		},
	);
	if (!response.ok) {
		return null;
	}
	const payload = await response.json();
	return payload && typeof payload === "object"
		? (payload as Record<string, unknown>)
		: null;
}

function shouldFetchLiveAgentPayload(
	actionType: string | undefined,
	status: string,
): boolean {
	if (actionType !== "dapr-agent/run") {
		return false;
	}
	return !["completed", "failed", "error", "terminated", "cancelled"].includes(
		status,
	);
}

export async function GET(
	request: Request,
	context: { params: Promise<{ executionId: string }> },
) {
	try {
		const { executionId } = await context.params;
		const session = await getSession(request);

		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const execution = await db.query.workflowExecutions.findFirst({
			where: eq(workflowExecutions.id, executionId),
			with: {
				workflow: true,
			},
		});

		if (!execution) {
			return NextResponse.json(
				{ error: "Execution not found" },
				{ status: 404 },
			);
		}

		if (execution.workflow.userId !== session.user.id) {
			return NextResponse.json({ error: "Forbidden" }, { status: 403 });
		}

		const [logsAsc, externalEvents, planArtifacts, agentRuns] =
			await Promise.all([
				db.query.workflowExecutionLogs.findMany({
					where: eq(workflowExecutionLogs.executionId, executionId),
					orderBy: [asc(workflowExecutionLogs.timestamp)],
				}),
				db
					.select()
					.from(workflowExternalEvents)
					.where(eq(workflowExternalEvents.executionId, executionId))
					.orderBy(asc(workflowExternalEvents.createdAt)),
				db
					.select()
					.from(workflowPlanArtifacts)
					.where(eq(workflowPlanArtifacts.workflowExecutionId, executionId))
					.orderBy(asc(workflowPlanArtifacts.createdAt)),
				db
					.select()
					.from(workflowAgentRuns)
					.where(eq(workflowAgentRuns.workflowExecutionId, executionId))
					.orderBy(asc(workflowAgentRuns.createdAt)),
			]);

		let runtimeStatus: Awaited<
			ReturnType<typeof genericOrchestratorClient.getWorkflowStatus>
		> | null = null;
		let runtimeHistory: Awaited<
			ReturnType<typeof genericOrchestratorClient.getWorkflowHistory>
		> | null = null;

		if (execution.daprInstanceId) {
			try {
				const orchestratorUrl =
					execution.workflow.daprOrchestratorUrl ||
					(await getGenericOrchestratorUrl());
				[runtimeStatus, runtimeHistory] = await Promise.all([
					genericOrchestratorClient.getWorkflowStatus(
						orchestratorUrl,
						execution.daprInstanceId,
					),
					genericOrchestratorClient.getWorkflowHistory(
						orchestratorUrl,
						execution.daprInstanceId,
					),
				]);
			} catch (error) {
				console.warn(
					`[Execution Logs] Failed to load runtime state for ${executionId}:`,
					error,
				);
			}
		}

		const redactedLogs = [...logsAsc]
			.sort(
				(a, b) =>
					new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
			)
			.map((log) => ({
				...log,
				input: redactSensitiveData(log.input),
				output: redactSensitiveData(log.output),
				actionType: log.activityName,
			}));

		const runtime = toDurableRuntimeSnapshot(runtimeStatus);
		const consistency = buildExecutionConsistency({
			dbStatus: execution.status,
			dbPhase: execution.phase,
			runtime,
		});
		const persistedAgentRuns = toDurableAgentRunSummary(agentRuns);
		const effectiveAgentRuns =
			persistedAgentRuns.length > 0
				? persistedAgentRuns
				: deriveDurableAgentRuns({
						executionId,
						parentExecutionId: execution.daprInstanceId ?? execution.id,
						logs: logsAsc,
						orchestratorHistory: runtimeHistory?.events ?? [],
					});
		const nodeActionTypeMap = getNodeActionTypeMap(execution.workflow.nodes);
		const agentProgressEntries = await Promise.all(
			effectiveAgentRuns.map(async (run) => {
				const actionType = nodeActionTypeMap.get(run.nodeId);
				const framework =
					actionType === "ms-agent/run"
						? "ms-agent"
						: actionType === "dapr-agent/run"
							? "dapr-agent"
							: null;
				if (!framework) {
					return null;
				}
				const livePayload = shouldFetchLiveAgentPayload(actionType, run.status)
					? await fetchAgentLivePayload(actionType, run.daprInstanceId)
					: null;
				return [
					run.nodeId,
					buildAgentNodeProgress(run, framework, livePayload),
				] as const;
			}),
		);
		const agentProgressByNode = Object.fromEntries(
			agentProgressEntries.filter(
				(
					entry,
				): entry is readonly [
					string,
					ReturnType<typeof buildAgentNodeProgress>,
				] => entry !== null,
			),
		);

		const timeline = buildDurableTimeline({
			execution,
			orchestratorHistory: runtimeHistory?.events ?? [],
			logs: logsAsc,
			externalEvents,
			planArtifacts,
			agentRuns: effectiveAgentRuns,
		}).map((event) => ({
			...event,
			input: redactSensitiveData(event.input),
			output: redactSensitiveData(event.output),
		}));

		return NextResponse.json({
			execution,
			logs: redactedLogs,
			runtime,
			timeline,
			agentProgressByNode,
			agentRuns: effectiveAgentRuns.map((run) => ({
				...run,
				result: redactSensitiveData(run.result),
			})),
			externalEvents: toDurableExternalEventSummary(externalEvents).map(
				(event) => ({
					...event,
					payload: redactSensitiveData(event.payload),
				}),
			),
			planArtifacts: toDurablePlanArtifactSummary(planArtifacts),
			consistency,
		});
	} catch (error) {
		console.error("Failed to get execution logs:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to get execution logs",
			},
			{ status: 500 },
		);
	}
}

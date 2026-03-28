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
	reconcileAgentRunWithLivePayload,
	toDurableAgentRunSummary,
	toDurableExternalEventSummary,
	toDurablePlanArtifactSummary,
	toDurableRuntimeSnapshot,
} from "@/lib/transforms/durable-timeline";
import { deriveAgentRunsFromExecutionOutput } from "@/lib/transforms/workflow-ui";
import { redactSensitiveData } from "@/lib/utils/redact";
import { resolveWorkflowExecutionIdAlias } from "@/lib/workflow-execution-alias";

const DAPR_AGENT_RUNTIME_API_BASE_URL =
	process.env.DAPR_AGENT_RUNTIME_API_BASE_URL ||
	"http://dapr-agent-runtime.workflow-builder.svc.cluster.local:8082";
const OPENSHELL_AGENT_RUNTIME_API_BASE_URL =
	process.env.OPENSHELL_AGENT_RUNTIME_API_BASE_URL ||
	"http://openshell-agent-runtime.openshell.svc.cluster.local:8083";
const OPENSHELL_LANGGRAPH_OBSERVABLE_API_BASE_URL =
	process.env.OPENSHELL_LANGGRAPH_OBSERVABLE_API_BASE_URL ||
	"http://openshell-langgraph-observable.workflow-builder.svc.cluster.local";

function getAgentRuntimeTarget(
	actionType: string | undefined,
): { baseUrl: string; path: string } | null {
	if (actionType === "dapr-agent/run") {
		return { baseUrl: DAPR_AGENT_RUNTIME_API_BASE_URL, path: "/api/run" };
	}
	if (actionType === "openshell-langgraph/run") {
		return { baseUrl: DAPR_AGENT_RUNTIME_API_BASE_URL, path: "/api/run" };
	}
	if (actionType === "openshell-langgraph-observable/run") {
		return {
			baseUrl: OPENSHELL_LANGGRAPH_OBSERVABLE_API_BASE_URL,
			path: "/api/run",
		};
	}
	if (actionType === "openshell/run") {
		return {
			baseUrl: OPENSHELL_AGENT_RUNTIME_API_BASE_URL,
			path: "/api/v1/agent-runs",
		};
	}
	return null;
}

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
	const target = getAgentRuntimeTarget(actionType);
	if (!target) {
		return null;
	}
	try {
		const response = await fetch(
			`${target.baseUrl.replace(/\/+$/, "")}${target.path}/${encodeURIComponent(instanceId)}`,
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
	} catch (error) {
		console.warn("Failed to fetch live agent payload for logs", {
			actionType,
			instanceId,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

function shouldFetchLiveAgentPayload(
	actionType: string | undefined,
	status: string,
): boolean {
	if (
		![
			"dapr-agent/run",
			"openshell/run",
			"openshell-langgraph/run",
			"openshell-langgraph-observable/run",
		].includes(actionType || "")
	) {
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
		const { executionId: requestedExecutionId } = await context.params;
		const executionId =
			await resolveWorkflowExecutionIdAlias(requestedExecutionId);
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
				: (() => {
						const derivedFromTimeline = deriveDurableAgentRuns({
							executionId,
							parentExecutionId: execution.daprInstanceId ?? execution.id,
							logs: logsAsc,
							orchestratorHistory: runtimeHistory?.events ?? [],
						});
						if (derivedFromTimeline.length > 0) {
							return derivedFromTimeline;
						}
						return deriveAgentRunsFromExecutionOutput(execution.output, {
							executionId,
							parentExecutionId: execution.daprInstanceId ?? execution.id,
							startedAt: execution.startedAt,
							completedAt: execution.completedAt,
							executionStatus: execution.status,
						});
					})();
		const nodeActionTypeMap = getNodeActionTypeMap(execution.workflow.nodes);
		const effectiveAgentRunsWithLive = await Promise.all(
			effectiveAgentRuns.map(async (run) => {
				const actionType = nodeActionTypeMap.get(run.nodeId);
				const livePayload = shouldFetchLiveAgentPayload(actionType, run.status)
					? await fetchAgentLivePayload(actionType, run.daprInstanceId)
					: null;
				return reconcileAgentRunWithLivePayload(run, livePayload);
			}),
		);
		const agentProgressEntries = effectiveAgentRunsWithLive.map((run) => {
			const actionType = nodeActionTypeMap.get(run.nodeId);
			const framework =
				actionType === "ms-agent/run"
					? "ms-agent"
					: actionType === "openshell/run" ||
							actionType === "openshell-langgraph/run" ||
							actionType === "openshell-langgraph-observable/run"
						? "openshell"
						: actionType === "dapr-agent/run"
							? "dapr-agent"
							: null;
			if (!framework) {
				return null;
			}
			return [
				run.nodeId,
				buildAgentNodeProgress(run, framework, run.result),
			] as const;
		});
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
			agentRuns: effectiveAgentRunsWithLive.map((run) => ({
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

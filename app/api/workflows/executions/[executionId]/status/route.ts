import { desc, eq } from "drizzle-orm";
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
} from "@/lib/db/schema";
import {
	buildAgentNodeProgress,
	buildExecutionConsistency,
	mapRuntimeStatusToLocalStatus,
	reconcileAgentRunWithLivePayload,
	toDurableAgentRunSummary,
	toDurableRuntimeSnapshot,
} from "@/lib/transforms/durable-timeline";
import {
	deriveAgentRunsFromExecutionOutput,
	extractExecutionTraceIds,
} from "@/lib/transforms/workflow-ui";
import type { AgentNodeProgress } from "@/lib/types/durable-timeline";
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
const MS_AGENT_API_BASE_URL =
	process.env.MS_AGENT_API_BASE_URL ||
	"http://ms-agent-workflow.workflow-builder.svc.cluster.local:8081";

function getAgentRuntimeTarget(
	actionType: string | undefined,
): { baseUrl: string; path: string } | null {
	if (actionType === "ms-agent/run") {
		return { baseUrl: MS_AGENT_API_BASE_URL, path: "/api/run" };
	}
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

type NodeStatus = {
	nodeId: string;
	nodeName: string;
	activityName: string | null;
	status: "pending" | "running" | "success" | "error";
	timestamp: string;
};

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
		console.warn("Failed to fetch live agent payload", {
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
	if (!actionType || !status) {
		return false;
	}
	if (
		![
			"dapr-agent/run",
			"openshell/run",
			"openshell-langgraph/run",
			"openshell-langgraph-observable/run",
		].includes(actionType)
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

		const schemaGuardResponse =
			await getWorkflowExecutionsSchemaGuardResponse();
		if (schemaGuardResponse) {
			return schemaGuardResponse;
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

		const [logs, agentRuns] = await Promise.all([
			db.query.workflowExecutionLogs.findMany({
				where: eq(workflowExecutionLogs.executionId, executionId),
				orderBy: [desc(workflowExecutionLogs.timestamp)],
			}),
			db
				.select()
				.from(workflowAgentRuns)
				.where(eq(workflowAgentRuns.workflowExecutionId, executionId))
				.orderBy(desc(workflowAgentRuns.createdAt)),
		]);

		const latestByNode = new Map<string, (typeof logs)[number]>();
		for (const log of logs) {
			if (!latestByNode.has(log.nodeId)) {
				latestByNode.set(log.nodeId, log);
			}
		}
		const nodeStatuses: NodeStatus[] = Array.from(latestByNode.values()).map(
			(log) => ({
				nodeId: log.nodeId,
				nodeName: log.nodeName,
				activityName: log.activityName,
				status: log.status,
				timestamp: log.timestamp.toISOString(),
			}),
		);

		let runtimeStatus: Awaited<
			ReturnType<typeof genericOrchestratorClient.getWorkflowStatus>
		> | null = null;
		if (execution.daprInstanceId) {
			try {
				const orchestratorUrl =
					execution.workflow.daprOrchestratorUrl ||
					(await getGenericOrchestratorUrl());
				runtimeStatus = await genericOrchestratorClient.getWorkflowStatus(
					orchestratorUrl,
					execution.daprInstanceId,
				);
			} catch (error) {
				console.warn(
					`[Execution Status] Failed to poll runtime for ${executionId}:`,
					error,
				);
			}
		}

		const runtime = toDurableRuntimeSnapshot(runtimeStatus);
		const mapped = runtime
			? mapRuntimeStatusToLocalStatus({
					runtimeStatus: runtime.runtimeStatus,
					phase: runtime.phase,
					message: runtime.message,
					outputs: runtime.outputs,
					error: runtime.error,
					fallbackStatus: execution.status,
				})
			: {
					status: execution.status as
						| "pending"
						| "running"
						| "success"
						| "error"
						| "cancelled",
					error: execution.error,
				};

		if (runtime) {
			const shouldComplete =
				mapped.status === "success" ||
				mapped.status === "error" ||
				mapped.status === "cancelled";
			await db
				.update(workflowExecutions)
				.set({
					status: mapped.status,
					phase: runtime.phase,
					progress: runtime.progress,
					output:
						(runtime.outputs as Record<string, unknown> | undefined) ??
						execution.output,
					error: mapped.error,
					...(shouldComplete ? { completedAt: new Date() } : {}),
				})
				.where(eq(workflowExecutions.id, executionId));
		}

		const consistency = buildExecutionConsistency({
			dbStatus: execution.status,
			dbPhase: execution.phase,
			runtime,
		});
		const nodeActionTypeMap = getNodeActionTypeMap(execution.workflow.nodes);
		const persistedAgentRuns = toDurableAgentRunSummary(agentRuns);
		const normalizedAgentRuns =
			persistedAgentRuns.length > 0
				? persistedAgentRuns
				: deriveAgentRunsFromExecutionOutput(execution.output, {
						executionId,
						parentExecutionId: execution.daprInstanceId ?? execution.id,
						startedAt: execution.startedAt,
						completedAt: execution.completedAt,
						executionStatus: execution.status,
					});
		const agentProgressEntries = await Promise.all(
			normalizedAgentRuns.map(async (run) => {
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
				const livePayload = shouldFetchLiveAgentPayload(actionType, run.status)
					? await fetchAgentLivePayload(actionType, run.daprInstanceId)
					: null;
				const effectiveRun = reconcileAgentRunWithLivePayload(run, livePayload);
				const progress = buildAgentNodeProgress(
					effectiveRun,
					framework,
					livePayload,
				);
				progress.nodeId = run.nodeId;
				return [run.nodeId, progress] as const;
			}),
		);
		const agentProgressByNode = Object.fromEntries(
			agentProgressEntries.filter(
				(entry): entry is readonly [string, AgentNodeProgress] =>
					entry !== null,
			),
		);

		return NextResponse.json({
			status: mapped.status,
			runtimeStatus: runtime?.runtimeStatus ?? null,
			traceId:
				runtime?.traceId ??
				Object.values(agentProgressByNode).find((value) => value.traceId)
					?.traceId ??
				extractExecutionTraceIds(execution.output)[0] ??
				null,
			phase: runtime?.phase ?? execution.phase,
			progress: runtime?.progress ?? execution.progress,
			message: runtime?.message ?? null,
			currentNodeId: runtime?.currentNodeId ?? null,
			currentNodeName: runtime?.currentNodeName ?? null,
			approvalEventName: runtime?.approvalEventName ?? null,
			agentProgressByNode,
			nodeStatuses,
			consistency,
		});
	} catch (error) {
		console.error("Failed to get execution status:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to get execution status",
			},
			{ status: 500 },
		);
	}
}

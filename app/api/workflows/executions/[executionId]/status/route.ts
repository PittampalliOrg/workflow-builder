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
	toDurableRuntimeSnapshot,
} from "@/lib/transforms/durable-timeline";
import type { AgentNodeProgress } from "@/lib/types/durable-timeline";

const DAPR_AGENT_RUNTIME_API_BASE_URL =
	process.env.DAPR_AGENT_RUNTIME_API_BASE_URL ||
	"http://dapr-agent-runtime.workflow-builder.svc.cluster.local:8082";
const MS_AGENT_API_BASE_URL =
	process.env.MS_AGENT_API_BASE_URL ||
	"http://ms-agent-workflow.workflow-builder.svc.cluster.local:8081";

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
	const baseUrl =
		actionType === "ms-agent/run"
			? MS_AGENT_API_BASE_URL
			: actionType === "dapr-agent/run"
				? DAPR_AGENT_RUNTIME_API_BASE_URL
				: null;
	if (!baseUrl) {
		return null;
	}
	const response = await fetch(
		`${baseUrl.replace(/\/+$/, "")}/api/run/${encodeURIComponent(instanceId)}`,
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
		const agentProgressEntries = await Promise.all(
			agentRuns.map(async (run) => {
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
				const livePayload =
					run.status === "scheduled"
						? await fetchAgentLivePayload(actionType, run.daprInstanceId)
						: null;
				const progress = buildAgentNodeProgress(run, framework, livePayload);
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

import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { getGenericOrchestratorUrl } from "@/lib/config-service";
import { genericOrchestratorClient } from "@/lib/dapr-client";
import { db } from "@/lib/db";
import { getWorkflowExecutionsSchemaGuardResponse } from "@/lib/db/workflow-executions-schema-guard";
import { workflowExecutionLogs, workflowExecutions } from "@/lib/db/schema";
import {
	buildExecutionConsistency,
	mapRuntimeStatusToLocalStatus,
	toDurableRuntimeSnapshot,
} from "@/lib/transforms/durable-timeline";

type NodeStatus = {
	nodeId: string;
	nodeName: string;
	activityName: string | null;
	status: "pending" | "running" | "success" | "error";
	timestamp: string;
};

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

		const logs = await db.query.workflowExecutionLogs.findMany({
			where: eq(workflowExecutionLogs.executionId, executionId),
			orderBy: [desc(workflowExecutionLogs.timestamp)],
		});

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

		return NextResponse.json({
			status: mapped.status,
			runtimeStatus: runtime?.runtimeStatus ?? null,
			phase: runtime?.phase ?? execution.phase,
			progress: runtime?.progress ?? execution.progress,
			message: runtime?.message ?? null,
			currentNodeId: runtime?.currentNodeId ?? null,
			currentNodeName: runtime?.currentNodeName ?? null,
			approvalEventName: runtime?.approvalEventName ?? null,
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

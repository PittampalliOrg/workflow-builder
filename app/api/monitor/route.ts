import { type NextRequest, NextResponse } from "next/server";
import { getWorkflowOrchestratorUrl } from "@/lib/config-service";
import { genericOrchestratorClient } from "@/lib/dapr-client";
import { mapWorkflowStatus } from "@/lib/transforms/workflow-ui";
import type {
	WorkflowListItem,
	WorkflowPhase,
	WorkflowUIStatus,
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

function toWorkflowListItem(
	item: Awaited<
		ReturnType<typeof genericOrchestratorClient.listWorkflows>
	>["workflows"][number],
): WorkflowListItem {
	const phase = toWorkflowPhase(item.phase);
	return {
		instanceId: item.instanceId,
		workflowType: item.workflowName || item.workflowId || "workflow",
		appId: "workflow-orchestrator",
		status: mapWorkflowStatus(item.runtimeStatus),
		startTime: item.startedAt || new Date().toISOString(),
		endTime: item.completedAt || null,
		customStatus:
			phase || item.progress !== undefined || item.message || item.currentNodeName
				? {
						phase: phase || "executing",
						progress: item.progress ?? 0,
						message: item.message || "",
						currentTask: item.currentNodeName || undefined,
					}
				: undefined,
		workflowName: item.workflowName || undefined,
	};
}

function toRuntimeStatusFilter(
	statuses: WorkflowUIStatus[] | undefined,
): string[] | undefined {
	if (!statuses?.length) return undefined;
	const mapped = statuses.flatMap((status) => {
		if (status === "RUNNING") return ["RUNNING", "PENDING"];
		if (status === "COMPLETED") return ["COMPLETED"];
		if (status === "FAILED") return ["FAILED"];
		if (status === "SUSPENDED") return ["SUSPENDED"];
		if (status === "TERMINATED" || status === "CANCELLED") {
			return ["TERMINATED", "CANCELED"];
		}
		return [];
	});
	return mapped.length ? [...new Set(mapped)] : undefined;
}

/**
 * GET /api/monitor
 * Dapr-first workflow execution list via orchestrator APIs.
 */
export async function GET(request: NextRequest) {
	try {
		const searchParams = request.nextUrl.searchParams;
		const search = searchParams.get("search") || undefined;
		const statusFilter = searchParams.get("status")?.split(",") as
			| WorkflowUIStatus[]
			| undefined;
		const limit = Number.parseInt(searchParams.get("limit") || "50", 10);
		const offset = Number.parseInt(searchParams.get("offset") || "0", 10);

		const orchestratorUrl = await getWorkflowOrchestratorUrl();
		const response = await genericOrchestratorClient.listWorkflows(
			orchestratorUrl,
			{
				search,
				status: toRuntimeStatusFilter(statusFilter),
				limit,
				offset,
			},
		);

		return NextResponse.json({
			workflows: response.workflows.map(toWorkflowListItem),
			total: response.total,
			limit: response.limit,
			offset: response.offset,
		});
	} catch (error) {
		console.error("Error fetching workflow executions:", error);
		return NextResponse.json(
			{ error: "Failed to fetch workflow executions" },
			{ status: 500 },
		);
	}
}

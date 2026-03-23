/**
 * GET /api/workflows/executions/[executionId]/detail — Execution detail for dashboard
 *
 * Fetches full execution detail from orchestrator: status, input/output,
 * history events, metadata. Uses the orchestrator instanceId directly.
 */

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";
import { allowAnonymousDaprDebug } from "@/lib/dapr/debug-access";
import { getWorkflowOrchestratorUrl } from "@/lib/config-service";
import { genericOrchestratorClient } from "@/lib/dapr-client";
import { db } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";
import type {
	WorkflowExecutionDetail,
	WorkflowHistoryEvent,
} from "@/lib/types/workflow-dashboard";
import type { WorkflowUIStatus } from "@/lib/types/workflow-ui";
import { resolveWorkflowExecutionIdAlias } from "@/lib/workflow-execution-alias";

function mapRuntimeStatusToUI(runtimeStatus: string): WorkflowUIStatus {
	switch (runtimeStatus.toUpperCase()) {
		case "RUNNING":
			return "RUNNING";
		case "PENDING":
			return "PENDING";
		case "COMPLETED":
			return "COMPLETED";
		case "FAILED":
			return "FAILED";
		case "TERMINATED":
			return "TERMINATED";
		case "CANCELED":
			return "CANCELLED";
		case "SUSPENDED":
			return "SUSPENDED";
		default:
			return "PENDING";
	}
}

function formatDuration(startTime?: string, endTime?: string): string | null {
	if (!startTime || !endTime) return null;
	const ms = new Date(endTime).getTime() - new Date(startTime).getTime();
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export async function GET(
	request: Request,
	{ params }: { params: Promise<{ executionId: string }> },
) {
	const session = await getSession(request);
	if (!session?.user && !allowAnonymousDaprDebug()) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { executionId: requestedExecutionId } = await params;

	try {
		const executionId =
			await resolveWorkflowExecutionIdAlias(requestedExecutionId);
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

		if (
			!allowAnonymousDaprDebug() &&
			execution.workflow.userId !== session?.user.id
		) {
			return NextResponse.json({ error: "Forbidden" }, { status: 403 });
		}

		const instanceId = execution.daprInstanceId || execution.id;
		const orchestratorUrl = await getWorkflowOrchestratorUrl();

		// Fetch status and history in parallel
		const [status, historyResponse] = await Promise.all([
			genericOrchestratorClient.getWorkflowStatus(orchestratorUrl, instanceId),
			genericOrchestratorClient
				.getWorkflowHistory(orchestratorUrl, instanceId)
				.catch(() => ({ instanceId, events: [] })),
		]);

		const history: WorkflowHistoryEvent[] = historyResponse.events.map((e) => ({
			eventId: e.eventId ?? null,
			eventType: e.eventType,
			name: e.name ?? null,
			timestamp: e.timestamp ?? "",
			input: e.input,
			output: e.output,
		}));

		const response: WorkflowExecutionDetail = {
			instanceId,
			workflowName:
				status.workflowName || status.workflowId || execution.workflow.name,
			appId: "workflow-orchestrator",
			status: mapRuntimeStatusToUI(status.runtimeStatus),
			startTime: status.startedAt || execution.startedAt.toISOString(),
			endTime:
				status.completedAt || execution.completedAt?.toISOString() || null,
			executionTime: formatDuration(status.startedAt, status.completedAt),
			input: execution.input,
			output: status.outputs || execution.output || null,
			history,
			error: status.error || execution.error || null,
		};

		return NextResponse.json(response, {
			headers: { "Cache-Control": "no-store" },
		});
	} catch (error) {
		console.error("[Execution Detail API] Error:", error);
		return NextResponse.json(
			{ error: "Failed to fetch execution detail" },
			{ status: 500 },
		);
	}
}

/**
 * GET /api/workflows/executions/[executionId]/graph — Workflow runtime graph
 *
 * Fetches the workflow definition (nodes/edges) from DB and combines with
 * execution history from the orchestrator to produce a runtime graph with
 * per-node status annotations.
 */

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { allowAnonymousDaprDebug } from "@/lib/dapr/debug-access";
import { getWorkflowOrchestratorUrl } from "@/lib/config-service";
import { genericOrchestratorClient } from "@/lib/dapr-client";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { buildWorkflowRuntimeGraph } from "@/lib/workflow-runtime-graph";
import type { DaprExecutionEvent } from "@/lib/types/workflow-ui";
import type { GenericWorkflowHistoryEvent } from "@/lib/dapr-client";

export const dynamic = "force-dynamic";

function toExecutionEvents(events: GenericWorkflowHistoryEvent[]): DaprExecutionEvent[] {
	return events.map((e) => ({
		eventId: e.eventId ?? null,
		eventType: e.eventType,
		name: e.name ?? null,
		timestamp: e.timestamp ?? "",
		input: e.input,
		output: e.output,
		metadata: e.metadata as DaprExecutionEvent["metadata"],
	}));
}

export async function GET(
	request: Request,
	{ params }: { params: Promise<{ executionId: string }> },
) {
	const session = await getSession(request);
	if (!session?.user && !allowAnonymousDaprDebug()) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { executionId: instanceId } = await params;

	try {
		const orchestratorUrl = await getWorkflowOrchestratorUrl();

		// Fetch status and history in parallel
		const [status, historyResponse] = await Promise.all([
			genericOrchestratorClient.getWorkflowStatus(
				orchestratorUrl,
				instanceId,
			),
			genericOrchestratorClient
				.getWorkflowHistory(orchestratorUrl, instanceId)
				.catch(() => ({ instanceId, events: [] })),
		]);

		// Find the workflow definition in DB by name
		const workflowName =
			status.workflowName || status.workflowId || "unknown";
		const [workflow] = await db
			.select({ nodes: workflows.nodes, edges: workflows.edges })
			.from(workflows)
			.where(eq(workflows.name, workflowName))
			.limit(1);

		if (!workflow?.nodes || !workflow?.edges) {
			return NextResponse.json(
				{ nodes: [], edges: [], source: "definition", layout: "auto" },
				{ headers: { "Cache-Control": "no-store" } },
			);
		}

		const graph = buildWorkflowRuntimeGraph({
			nodes: workflow.nodes,
			edges: workflow.edges,
			executionHistory: toExecutionEvents(historyResponse.events),
			daprStatus: {
				runtimeStatus: status.runtimeStatus as import("@/lib/types/workflow-ui").DaprRuntimeStatus,
				currentNodeId: status.currentNodeId,
				currentNodeName: status.currentNodeName,
				error: status.error,
			},
		});

		return NextResponse.json(graph, {
			headers: { "Cache-Control": "no-store" },
		});
	} catch (error) {
		console.error("[Execution Graph API] Error:", error);
		return NextResponse.json(
			{ error: "Failed to fetch execution graph" },
			{ status: 500 },
		);
	}
}

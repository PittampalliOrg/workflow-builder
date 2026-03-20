/**
 * GET /api/workflows/executions/[executionId]/relationships — Related executions
 *
 * Finds executions related via rerun chains:
 * - The source execution this was rerun from
 * - Any reruns spawned from this execution
 */

import { eq, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";
import { allowAnonymousDaprDebug } from "@/lib/dapr/debug-access";
import { db } from "@/lib/db";
import { workflowExecutions, workflows } from "@/lib/db/schema";
import type { WorkflowUIStatus } from "@/lib/types/workflow-ui";

type RelationshipRow = {
	instanceId: string;
	status: WorkflowUIStatus;
	relationship: "rerun-source" | "rerun-child";
	appId: string;
	startTime: string;
	endTime: string | null;
};

function mapDbStatusToUI(status: string): WorkflowUIStatus {
	switch (status) {
		case "running":
			return "RUNNING";
		case "pending":
			return "PENDING";
		case "success":
			return "COMPLETED";
		case "error":
			return "FAILED";
		case "cancelled":
			return "CANCELLED";
		default:
			return "PENDING";
	}
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
		// First, find the DB execution by daprInstanceId or id
		const [execution] = await db
			.select({
				id: workflowExecutions.id,
				rerunOfExecutionId: workflowExecutions.rerunOfExecutionId,
				rerunSourceInstanceId: workflowExecutions.rerunSourceInstanceId,
			})
			.from(workflowExecutions)
			.where(
				or(
					eq(workflowExecutions.daprInstanceId, instanceId),
					eq(workflowExecutions.id, instanceId),
				),
			)
			.limit(1);

		if (!execution) {
			return NextResponse.json(
				{ relationships: [] },
				{ headers: { "Cache-Control": "no-store" } },
			);
		}

		const relationships: RelationshipRow[] = [];

		// Find the source execution (parent rerun)
		if (execution.rerunOfExecutionId) {
			const [source] = await db
				.select({
					id: workflowExecutions.id,
					daprInstanceId: workflowExecutions.daprInstanceId,
					status: workflowExecutions.status,
					startedAt: workflowExecutions.startedAt,
					completedAt: workflowExecutions.completedAt,
				})
				.from(workflowExecutions)
				.where(eq(workflowExecutions.id, execution.rerunOfExecutionId))
				.limit(1);

			if (source) {
				relationships.push({
					instanceId: source.daprInstanceId || source.id,
					status: mapDbStatusToUI(source.status),
					relationship: "rerun-source",
					appId: "workflow-orchestrator",
					startTime: source.startedAt.toISOString(),
					endTime: source.completedAt?.toISOString() ?? null,
				});
			}
		}

		// Find child reruns (executions that were rerun from this one)
		const children = await db
			.select({
				id: workflowExecutions.id,
				daprInstanceId: workflowExecutions.daprInstanceId,
				status: workflowExecutions.status,
				startedAt: workflowExecutions.startedAt,
				completedAt: workflowExecutions.completedAt,
			})
			.from(workflowExecutions)
			.where(eq(workflowExecutions.rerunOfExecutionId, execution.id));

		for (const child of children) {
			relationships.push({
				instanceId: child.daprInstanceId || child.id,
				status: mapDbStatusToUI(child.status),
				relationship: "rerun-child",
				appId: "workflow-orchestrator",
				startTime: child.startedAt.toISOString(),
				endTime: child.completedAt?.toISOString() ?? null,
			});
		}

		return NextResponse.json(
			{ relationships },
			{ headers: { "Cache-Control": "no-store" } },
		);
	} catch (error) {
		console.error("[Execution Relationships API] Error:", error);
		return NextResponse.json(
			{ error: "Failed to fetch relationships" },
			{ status: 500 },
		);
	}
}

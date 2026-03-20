/**
 * GET /api/workflows/names/[appId]/[workflowName] — Single workflow name detail
 *
 * Returns summary stats and latest executions for a specific workflow name,
 * queried from the workflow_executions DB table.
 */

import { desc, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";
import { allowAnonymousDaprDebug } from "@/lib/dapr/debug-access";
import { db } from "@/lib/db";
import { workflowExecutions, workflows } from "@/lib/db/schema";
import type {
	WorkflowExecutionSummary,
	WorkflowNameDetail,
} from "@/lib/types/workflow-dashboard";
import type { WorkflowUIStatus } from "@/lib/types/workflow-ui";

function mapDbStatusToUI(
	status: string,
): WorkflowUIStatus {
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

function formatDuration(
	startTime: Date | null,
	endTime: Date | null,
): string | null {
	if (!startTime || !endTime) return null;
	const ms = endTime.getTime() - startTime.getTime();
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export async function GET(
	request: Request,
	{ params }: { params: Promise<{ appId: string; workflowName: string }> },
) {
	const session = await getSession(request);
	if (!session?.user && !allowAnonymousDaprDebug()) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { workflowName } = await params;
	const decodedName = decodeURIComponent(workflowName);

	try {
		// Get stats in one query
		const [stats] = await db
			.select({
				total: sql<number>`count(*)`,
				running: sql<number>`count(*) filter (where ${workflowExecutions.status} in ('running', 'pending'))`,
				success: sql<number>`count(*) filter (where ${workflowExecutions.status} = 'success')`,
				failed: sql<number>`count(*) filter (where ${workflowExecutions.status} in ('error', 'cancelled'))`,
			})
			.from(workflowExecutions)
			.innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
			.where(eq(workflows.name, decodedName));

		// Get latest executions
		const rows = await db
			.select({
				id: workflowExecutions.id,
				daprInstanceId: workflowExecutions.daprInstanceId,
				status: workflowExecutions.status,
				startedAt: workflowExecutions.startedAt,
				completedAt: workflowExecutions.completedAt,
			})
			.from(workflowExecutions)
			.innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
			.where(eq(workflows.name, decodedName))
			.orderBy(desc(workflowExecutions.startedAt))
			.limit(50);

		const executions: WorkflowExecutionSummary[] = rows.map((row) => ({
			instanceId: row.daprInstanceId || row.id,
			status: mapDbStatusToUI(row.status),
			startTime: row.startedAt.toISOString(),
			endTime: row.completedAt?.toISOString() ?? null,
			executionTime: formatDuration(row.startedAt, row.completedAt),
		}));

		const total = Number(stats.total);
		const success = Number(stats.success);
		const successRate = total > 0 ? Math.round((success / total) * 100) : 0;

		const response: WorkflowNameDetail = {
			name: decodedName,
			appId: "workflow-orchestrator",
			totalExecutions: total,
			running: Number(stats.running),
			success,
			failed: Number(stats.failed),
			successRate,
			executions,
		};

		return NextResponse.json(response, {
			headers: { "Cache-Control": "no-store" },
		});
	} catch (error) {
		console.error("[Workflow Name Detail API] Error:", error);
		return NextResponse.json(
			{ error: "Failed to fetch workflow detail" },
			{ status: 500 },
		);
	}
}

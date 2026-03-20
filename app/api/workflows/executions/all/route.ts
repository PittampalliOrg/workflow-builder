/**
 * GET /api/workflows/executions/all — Flat list of all workflow executions
 *
 * Queries workflow_executions joined with workflows to produce a flat table
 * of individual executions with workflow name, status, timing, etc.
 */

import { and, count, desc, eq, isNull, or, ilike } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { allowAnonymousDaprDebug } from "@/lib/dapr/debug-access";
import { db } from "@/lib/db";
import { workflowExecutions, workflows } from "@/lib/db/schema";
import type {
	AllExecutionRow,
	AllExecutionsResponse,
} from "@/lib/types/workflow-dashboard";
import type { WorkflowUIStatus } from "@/lib/types/workflow-ui";

export const dynamic = "force-dynamic";

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

export async function GET(request: Request) {
	const session = await getSession(request);
	if (!session?.user && !allowAnonymousDaprDebug()) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const url = new URL(request.url);
	const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
	const offset = Number(url.searchParams.get("offset")) || 0;
	const search = url.searchParams.get("search")?.toLowerCase() ?? "";
	const latestOnly = url.searchParams.get("latestOnly") === "true";

	try {
		const conditions = [];
		if (search) {
			conditions.push(or(
				ilike(workflows.name, `%${search}%`),
				ilike(workflowExecutions.daprInstanceId, `%${search}%`),
			));
		}
		if (latestOnly) {
			conditions.push(isNull(workflowExecutions.rerunOfExecutionId));
		}
		const whereClause = conditions.length === 0
			? undefined
			: conditions.length === 1
				? conditions[0]
				: and(...conditions);

		const [rows, totalResult] = await Promise.all([
			db
				.select({
					id: workflowExecutions.id,
					daprInstanceId: workflowExecutions.daprInstanceId,
					status: workflowExecutions.status,
					workflowName: workflows.name,
					startedAt: workflowExecutions.startedAt,
					completedAt: workflowExecutions.completedAt,
				})
				.from(workflowExecutions)
				.innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
				.where(whereClause)
				.orderBy(desc(workflowExecutions.startedAt))
				.limit(limit)
				.offset(offset),
			db
				.select({ count: count() })
				.from(workflowExecutions)
				.innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
				.where(whereClause),
		]);

		const executions: AllExecutionRow[] = rows.map((row) => ({
			instanceId: row.daprInstanceId || row.id,
			status: mapDbStatusToUI(row.status),
			workflowName: row.workflowName,
			appId: "workflow-orchestrator",
			startTime: row.startedAt.toISOString(),
			executionTime: formatDuration(row.startedAt, row.completedAt),
		}));

		const response: AllExecutionsResponse = {
			executions,
			totalRows: totalResult[0]?.count ?? 0,
		};

		return NextResponse.json(response, {
			headers: { "Cache-Control": "no-store" },
		});
	} catch (error) {
		console.error("[All Executions API] Error:", error);
		return NextResponse.json(
			{ executions: [], totalRows: 0 } satisfies AllExecutionsResponse,
			{ headers: { "Cache-Control": "no-store" } },
		);
	}
}

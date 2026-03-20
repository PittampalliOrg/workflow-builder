/**
 * GET /api/workflows/names — Aggregated workflow names list
 *
 * Queries the workflow_executions DB table (joined with workflows for names),
 * groups by workflow name, and computes per-name execution counts.
 *
 * This replaces the previous orchestrator-based QueryInstances approach,
 * which fails on Redis-backed Dapr runtimes ("unimplemented").
 */

import { count, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";
import { allowAnonymousDaprDebug } from "@/lib/dapr/debug-access";
import { db } from "@/lib/db";
import { workflowExecutions, workflows } from "@/lib/db/schema";
import type {
	WorkflowNameSummary,
	WorkflowNamesResponse,
} from "@/lib/types/workflow-dashboard";

export async function GET(request: Request) {
	const session = await getSession(request);
	if (!session?.user && !allowAnonymousDaprDebug()) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const url = new URL(request.url);
	const search = url.searchParams.get("search")?.toLowerCase() ?? "";

	try {
		const rows = await db
			.select({
				name: workflows.name,
				totalExecutions: count(workflowExecutions.id),
				running: sql<number>`count(*) filter (where ${workflowExecutions.status} in ('running', 'pending'))`.as("running"),
				success: sql<number>`count(*) filter (where ${workflowExecutions.status} = 'success')`.as("success"),
				failed: sql<number>`count(*) filter (where ${workflowExecutions.status} in ('error', 'cancelled'))`.as("failed"),
			})
			.from(workflowExecutions)
			.innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
			.groupBy(workflows.name)
			.orderBy(workflows.name);

		let result: WorkflowNameSummary[] = rows.map((row) => ({
			name: row.name,
			appId: "workflow-orchestrator",
			totalExecutions: row.totalExecutions,
			running: Number(row.running),
			success: Number(row.success),
			failed: Number(row.failed),
		}));

		if (search) {
			result = result.filter(
				(w) =>
					w.name.toLowerCase().includes(search) ||
					w.appId.toLowerCase().includes(search),
			);
		}

		const response: WorkflowNamesResponse = {
			workflows: result,
			totalRows: result.length,
		};

		return NextResponse.json(response, {
			headers: { "Cache-Control": "no-store" },
		});
	} catch (error) {
		console.error("[Workflows Names API] Error:", error);
		return NextResponse.json(
			{ workflows: [], totalRows: 0 } satisfies WorkflowNamesResponse,
			{ headers: { "Cache-Control": "no-store" } },
		);
	}
}

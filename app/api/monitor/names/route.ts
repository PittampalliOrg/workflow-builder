import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { workflowExecutions, workflows } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import type { WorkflowNameStats } from "@/lib/types/workflow-ui";

export const dynamic = "force-dynamic";

/**
 * GET /api/monitor/names
 * Get aggregated statistics by workflow name
 */
export async function GET(request: NextRequest) {
  try {
    // Aggregate by workflow name
    const results = await db
      .select({
        workflowId: workflows.id,
        name: workflows.name,
        totalExecutions: sql<number>`count(*)::int`,
        runningCount: sql<number>`count(case when ${workflowExecutions.status} = 'running' then 1 end)::int`,
        successCount: sql<number>`count(case when ${workflowExecutions.status} = 'success' then 1 end)::int`,
        failedCount: sql<number>`count(case when ${workflowExecutions.status} = 'error' then 1 end)::int`,
      })
      .from(workflowExecutions)
      .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
      .groupBy(workflows.id, workflows.name)
      .orderBy(sql`count(*) desc`);

    // Transform to UI format
    const stats: WorkflowNameStats[] = results.map((result) => ({
      name: result.name,
      appId: "workflow-builder",
      totalExecutions: result.totalExecutions,
      runningCount: result.runningCount,
      successCount: result.successCount,
      failedCount: result.failedCount,
    }));

    return NextResponse.json({
      stats,
      total: stats.length,
    });
  } catch (error) {
    console.error("Error fetching workflow name stats:", error);
    return NextResponse.json(
      { error: "Failed to fetch workflow name stats" },
      { status: 500 }
    );
  }
}

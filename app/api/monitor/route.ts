import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { workflowExecutions, workflows } from "@/lib/db/schema";
import { desc, eq, or, ilike, and } from "drizzle-orm";
import { toWorkflowListItem } from "@/lib/transforms/workflow-ui";
import type { WorkflowListItem, WorkflowUIStatus } from "@/lib/types/workflow-ui";

export const dynamic = "force-dynamic";

/**
 * GET /api/monitor
 * List all workflow executions with filtering and pagination
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const search = searchParams.get("search") || undefined;
    const statusFilter = searchParams.get("status")?.split(",") as WorkflowUIStatus[] | undefined;
    const limit = parseInt(searchParams.get("limit") || "50");
    const offset = parseInt(searchParams.get("offset") || "0");

    // Build query
    let query = db
      .select({
        execution: workflowExecutions,
        workflow: workflows,
      })
      .from(workflowExecutions)
      .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
      .$dynamic();

    // Apply filters
    const filters = [];

    if (search) {
      filters.push(
        or(
          ilike(workflowExecutions.id, `%${search}%`),
          ilike(workflows.name, `%${search}%`)
        )
      );
    }

    if (statusFilter && statusFilter.length > 0) {
      // Map UI status to database status
      const dbStatuses = statusFilter.map((status) => {
        switch (status) {
          case "RUNNING":
            return "running";
          case "COMPLETED":
            return "success";
          case "FAILED":
            return "error";
          case "CANCELLED":
            return "cancelled";
          default:
            return "running";
        }
      });
      filters.push(
        or(...dbStatuses.map((status) => eq(workflowExecutions.status, status as any)))
      );
    }

    if (filters.length > 0) {
      query = query.where(and(...filters));
    }

    // Execute query with pagination
    const results = await query
      .orderBy(desc(workflowExecutions.startedAt))
      .limit(limit)
      .offset(offset);

    // Transform to UI format
    const items: WorkflowListItem[] = results.map(({ execution, workflow }) =>
      toWorkflowListItem(execution, workflow)
    );

    return NextResponse.json({
      workflows: items,
      total: results.length,
      limit,
      offset,
    });
  } catch (error) {
    console.error("Error fetching workflow executions:", error);
    return NextResponse.json(
      { error: "Failed to fetch workflow executions" },
      { status: 500 }
    );
  }
}

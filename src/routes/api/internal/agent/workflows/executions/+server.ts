import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { validateInternalOrPreviewControlRead } from "$lib/server/internal-auth";
import { getApplicationAdapters } from "$lib/server/application";

function parseIntegerParam(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * GET /api/internal/agent/workflows/executions
 *
 * Lists workflow executions with optional filters (workflowId, workflowName, status, limit, offset).
 * Security: Validated via X-Internal-Token header.
 */
export const GET: RequestHandler = async ({ request, url }) => {
  if (!validateInternalOrPreviewControlRead(request)) {
    return error(401, "Unauthorized");
  }

  const workflowId = url.searchParams.get("workflowId") ?? undefined;
  const workflowName = url.searchParams.get("workflowName") ?? undefined;
  const status = url.searchParams.get("status") ?? undefined;
  const limit = Math.max(
    1,
    Math.min(parseIntegerParam(url.searchParams.get("limit")) ?? 100, 500),
  );
  const offset = Math.max(
    0,
    parseIntegerParam(url.searchParams.get("offset")) ?? 0,
  );

  try {
    return json(
      await getApplicationAdapters().workflowData.listInternalAgentWorkflowExecutions(
        {
          workflowId,
          workflowName,
          status: status?.trim()
            ? (status.trim() as
                | "pending"
                | "running"
                | "success"
                | "error"
                | "cancelled")
            : null,
          limit,
          offset,
        },
      ),
    );
  } catch (err) {
    if (err instanceof Error && err.message === "Database not configured") {
      return error(503, "Database not configured");
    }
    throw err;
  }
};

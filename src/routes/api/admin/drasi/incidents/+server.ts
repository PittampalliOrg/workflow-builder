import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import {
  buildDrasiIncidentsResponse,
  PLATFORM_INCIDENT_ANALYSIS_WORKFLOW_ID,
} from "$lib/server/application/drasi-incidents";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

function requestedLimit(raw: string | null): number {
  if (!raw) return DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(parsed, MAX_LIMIT));
}

export const GET: RequestHandler = async ({ locals, url }) => {
  const userId = locals.session?.userId;
  if (!userId) return error(401, "Authentication required");

  const adapters = getApplicationAdapters();
  const isAdmin = await adapters.workflowData.isPlatformAdmin(userId);
  if (!isAdmin) return error(403, "Admin access required");

  const limit = requestedLimit(url.searchParams.get("limit"));
  const executions = await adapters.workflowExecutions.listByWorkflowId({
    workflowId: PLATFORM_INCIDENT_ANALYSIS_WORKFLOW_ID,
    limit,
    include: "full",
  });

  return json(buildDrasiIncidentsResponse(executions, limit), {
    headers: {
      "cache-control": "private, no-store",
    },
  });
};

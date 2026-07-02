/**
 * POST /api/workflows/executions/[executionId]/approve
 *
 * Approve a run parked at an approval listen-gate by raising the awaited
 * external event to the orchestrator (e.g. the planGoal `goal_spec_approval`
 * gate). Body: { eventType?: string }. Defaults to "goal_spec_approval".
 *
 * Workspace-scoped via `assertInScope`.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { assertInScope } from "$lib/server/workflows/project-scope";
import { daprFetch, getOrchestratorUrl } from "$lib/server/dapr-client";

export const POST: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.session?.userId) return error(401, "Authentication required");
  const { executionId } = params;
  if (!executionId) return error(400, "executionId required");

  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    /* empty body ok */
  }
  const eventType =
    typeof body.eventType === "string" && body.eventType.trim()
      ? body.eventType.trim()
      : "goal_spec_approval";

  const exec = await getApplicationAdapters().workflowData.getExecutionById(executionId);
  assertInScope(exec, locals.session, "Execution not found");

  if (!exec.daprInstanceId) {
    return error(409, "Run has no Dapr instance to signal");
  }

  const orchestratorUrl = getOrchestratorUrl();
  const res = await daprFetch(
    `${orchestratorUrl}/api/v2/workflows/${encodeURIComponent(exec.daprInstanceId)}/events`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventName: eventType,
        eventData: {
          approved: true,
          approvedBy: locals.session.userId,
          source: "run-ui",
        },
      }),
    },
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`[approve] orchestrator ${res.status}:`, detail.slice(0, 300));
    return error(res.status === 404 ? 409 : 502, "Failed to raise approval event");
  }

  return json({ ok: true, eventType, instanceId: exec.daprInstanceId });
};

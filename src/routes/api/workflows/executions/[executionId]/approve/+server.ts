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
import type { WorkflowExecutionControlResult } from "$lib/server/application/workflow-execution-control";

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
  return workflowExecutionControlResponse(
    await getApplicationAdapters().workflowExecutionControl.approveExecution({
      executionId,
      body,
      projectId: locals.session.projectId ?? null,
      userId: locals.session.userId,
    }),
  );
};

function workflowExecutionControlResponse(result: WorkflowExecutionControlResult) {
  if (result.status === "error") return error(result.httpStatus, result.message);
  return json(result.body);
}

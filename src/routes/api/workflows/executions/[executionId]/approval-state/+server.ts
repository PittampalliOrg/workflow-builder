/**
 * GET /api/workflows/executions/[executionId]/approval-state
 *
 * Reports whether a run is currently PARKED at an approval listen-gate (e.g.
 * the planGoal `goal_spec_approval` gate) so the run UI can surface an Approve
 * affordance. A run is "awaiting" when it is still running and its current node
 * is a SW `listen` task. The awaited event type comes from the node's
 * `listen.to.one.with.type` (defaults to the node id).
 *
 * Workspace-scoped by the application service.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type { WorkflowExecutionControlResult } from "$lib/server/application/workflow-execution-control";

export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.session?.userId) return error(401, "Authentication required");
  const { executionId } = params;
  if (!executionId) return error(400, "executionId required");

  return workflowExecutionControlResponse(
    await getApplicationAdapters().workflowExecutionControl.getApprovalState({
      executionId,
      projectId: locals.session.projectId ?? null,
      userId: locals.session.userId,
    }),
  );
};

function workflowExecutionControlResponse(
  result: WorkflowExecutionControlResult,
) {
  if (result.status === "error")
    return error(result.httpStatus, result.message);
  return json(result.body);
}

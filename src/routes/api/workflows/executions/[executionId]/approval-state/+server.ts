/**
 * GET /api/workflows/executions/[executionId]/approval-state
 *
 * Reports whether a run is currently PARKED at an approval listen-gate (e.g.
 * the planGoal `goal_spec_approval` gate) so the run UI can surface an Approve
 * affordance. A run is "awaiting" when it is still running and its current node
 * is a SW `listen` task. The awaited event type comes from the node's
 * `listen.to.one.with.type` (defaults to the node id).
 *
 * Workspace-scoped via `assertInScope`.
 */

import { error, json } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import type { RequestHandler } from "./$types";
import { db } from "$lib/server/db";
import { workflows, workflowExecutions } from "$lib/server/db/schema";
import { assertInScope } from "$lib/server/workflows/project-scope";

const ACTIVE_STATUSES = new Set(["running", "pending", "paused"]);

function findListenGate(
  spec: unknown,
  nodeId: string | null,
): { eventType: string } | null {
  if (!nodeId || typeof spec !== "object" || spec === null) return null;
  const doList = (spec as Record<string, unknown>).do;
  if (!Array.isArray(doList)) return null;
  for (const entry of doList) {
    if (typeof entry !== "object" || entry === null) continue;
    const key = Object.keys(entry as Record<string, unknown>)[0];
    if (key !== nodeId) continue;
    const node = (entry as Record<string, unknown>)[key] as Record<string, unknown>;
    const listen = node?.listen as Record<string, unknown> | undefined;
    if (!listen) return null;
    const withType = (((listen.to as Record<string, unknown>)?.one as Record<string, unknown>)
      ?.with as Record<string, unknown>)?.type;
    return { eventType: typeof withType === "string" && withType ? withType : nodeId };
  }
  return null;
}

export const GET: RequestHandler = async ({ params, locals }) => {
  if (!db) return error(503, "Database not configured");
  if (!locals.session?.userId) return error(401, "Authentication required");
  const { executionId } = params;
  if (!executionId) return error(400, "executionId required");

  const [exec] = await db
    .select({
      id: workflowExecutions.id,
      projectId: workflowExecutions.projectId,
      userId: workflowExecutions.userId,
      workflowId: workflowExecutions.workflowId,
      status: workflowExecutions.status,
      currentNodeId: workflowExecutions.currentNodeId,
    })
    .from(workflowExecutions)
    .where(eq(workflowExecutions.id, executionId))
    .limit(1);
  assertInScope(exec, locals.session, "Execution not found");

  if (!ACTIVE_STATUSES.has(String(exec.status ?? "").toLowerCase())) {
    return json({ awaiting: false });
  }

  const [wf] = await db
    .select({ spec: workflows.spec })
    .from(workflows)
    .where(eq(workflows.id, exec.workflowId))
    .limit(1);

  const gate = findListenGate(wf?.spec, exec.currentNodeId);
  if (!gate) return json({ awaiting: false });

  return json({
    awaiting: true,
    nodeId: exec.currentNodeId,
    eventType: gate.eventType,
  });
};

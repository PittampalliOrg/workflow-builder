import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type { WorkflowExecutionControlResult } from "$lib/server/application/workflow-execution-control";
import { requirePlatformAdmin } from "$lib/server/platform-admin";

/** Admin-gated presentation adapter for target-aware development workflow starts. */
export const POST: RequestHandler = async ({ params, request, locals }) => {
  const userId = locals.session?.userId;
  if (!userId) return error(401, "Authentication required");
  await requirePlatformAdmin(locals);

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    /* empty body ok */
  }
  const payload =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const body: Record<string, unknown> = {};
  if ("input" in payload) body.input = payload.input;
  if ("budgetTotal" in payload) body.budgetTotal = payload.budgetTotal;

  return workflowExecutionControlResponse(
    await getApplicationAdapters().workflowExecutionControl.executeDevWorkflow({
      workflowId: params.workflowId,
      body,
      projectId: locals.session?.projectId ?? null,
      requestOrigin: request.headers.get("origin"),
      userId,
    }),
  );
};

function workflowExecutionControlResponse(
  result: WorkflowExecutionControlResult,
) {
  if (result.status === "error") return error(result.httpStatus, result.message);
  return json(result.body, { status: result.httpStatus ?? 200 });
}

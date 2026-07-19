import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { validateInternalToken } from "$lib/server/internal-auth";
import { getApplicationAdapters } from "$lib/server/application";
import { startWorkflowRun } from "$lib/server/workflows/start-run";
import { resolveInternalWorkflowPrincipal } from "../../../workflow-mcp-principal";

// ---------------------------------------------------------------------------
// POST /api/internal/agent/workflows/execute
//
// Called by internal services to register and start a workflow execution.
// Thin wrapper over the canonical startWorkflowRun() helper (the single start
// path shared with the public webhook + the event-driven workflow.triggers spine).
//
// Auth: requires INTERNAL_API_TOKEN via X-Internal-Token header.
// User-scoped calls also require a signed Workflow MCP principal. Trusted
// trigger infrastructure must opt into the separate workflow-trigger system
// lane with X-Wfb-System-Principal: workflow-trigger.
// Body: { workflowId?, workflowName?, triggerData? }
// Returns: { success, executionId, instanceId, workflowId, workflowName, status }
// ---------------------------------------------------------------------------

type ExecuteBody = {
	workflowId?: string;
	workflowName?: string;
	/** SW 1.0: an object of trigger fields. Dynamic-script: ANY JSON value,
	 *  passed verbatim as the script's `args` global (absent = undefined). */
	triggerData?: unknown;
	/** Dynamic-script token budget (forwarded to the start path for script workflows). */
	budgetTotal?: number | null;
	/** Deterministic execution id for at-least-once callers (e.g. the dapr-agent-py
	 * Workflow tool's start activity, which Dapr may retry). An existing row with
	 * this id short-circuits as a no-op instead of double-starting. */
	executionId?: string;
};

const EXECUTION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export const POST: RequestHandler = async ({ request }) => {
	if (!validateInternalToken(request)) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  const systemPrincipal = request.headers.get("x-wfb-system-principal")?.trim();
  const carriesUserContext = [
    "x-wfb-principal-assertion",
    "x-wfb-session-token",
    "x-wfb-session-id",
    "x-wfb-principal-user-id",
    "x-wfb-principal-project-id",
  ].some((header) => request.headers.has(header));
  if (systemPrincipal && systemPrincipal !== "workflow-trigger") {
    return json({ error: "Unsupported system principal" }, { status: 403 });
  }
  if (systemPrincipal && carriesUserContext) {
    return json(
      { error: "System and user workflow principals cannot be combined" },
      { status: 400 },
    );
  }

  let principal: { userId: string; projectId: string } | null = null;
  if (!systemPrincipal) {
    const sessionId = request.headers.get("x-wfb-session-id")?.trim();
    const principalResult = await resolveInternalWorkflowPrincipal(
      request,
      getApplicationAdapters().internalWorkflowPrincipal,
      {
        requiredScope: "workflow:execute",
        ...(sessionId
          ? { legacyResource: { kind: "session" as const, id: sessionId } }
          : {}),
      },
    );
    if (!principalResult.ok) {
      return json(
        { error: principalResult.error },
        { status: principalResult.status },
      );
    }
    principal = principalResult.principal;
	}

	const body = (await request.json().catch(() => ({}))) as ExecuteBody;
	const executionId =
    typeof body.executionId === "string" &&
    EXECUTION_ID_RE.test(body.executionId)
			? body.executionId
			: undefined;
	if (body.executionId !== undefined && executionId === undefined) {
    return json(
      { error: "executionId must match ^[A-Za-z0-9_-]{8,64}$" },
      { status: 400 },
    );
	}

	const budgetTotal =
    typeof body.budgetTotal === "number" && Number.isFinite(body.budgetTotal)
			? body.budgetTotal
			: undefined;
	const result = await startWorkflowRun({
		workflowId: body.workflowId,
		workflowName: body.workflowName,
		// Verbatim: dynamic-script accepts any JSON value (undefined = no args);
		// the SW start path coerces non-objects to {} itself.
		triggerData: body.triggerData,
    ...(principal
      ? { userId: principal.userId, projectId: principal.projectId }
      : {}),
		...(budgetTotal !== undefined ? { budgetTotal } : {}),
    ...(executionId ? { executionId, idempotent: true } : {}),
	});

	if (!result.ok) {
		if (result.status >= 500) {
      console.error("[internal/agent/workflows/execute] Failed:", result.error);
		}
		return json({ error: result.error }, { status: result.status });
	}

	return json({
		success: true,
		executionId: result.executionId,
		instanceId: result.instanceId,
		workflowId: result.workflowId,
		workflowName: result.workflowName,
    status: result.status,
	});
};

import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { validateInternalToken } from "$lib/server/internal-auth";
import { getApplicationAdapters } from "$lib/server/application";
import { startWorkflowRun } from "$lib/server/workflows/start-run";
import { extractStaticMeta } from "$lib/server/workflows/dynamic-script-validation";
import { resolveInternalWorkflowPrincipal } from "../../../workflow-mcp-principal";

// ---------------------------------------------------------------------------
// POST /api/internal/agent/workflows/execute-script
//
// Inline dynamic-script execution for the workflow-mcp-server `run_workflow_script`
// tool. Validates the source (server-truth via the script-evaluator), upserts an
// ephemeral PRIVATE dynamic-script workflow row owned by the spawning session's
// user/project, and starts a run via the canonical startWorkflowRun().
//
// Auth: requires INTERNAL_API_TOKEN via X-Internal-Token header.
// Ownership comes from trusted workflow-mcp principal headers or the existing
// internal platform-session lane. X-Wfb-Session-Id is optional MCP lineage.
// Body: { script, args?, budgetTotal? }
// Returns: { executionId, instanceId, workflowId }
// ---------------------------------------------------------------------------

type ExecuteScriptBody = {
	script?: string;
	/** The script's verbatim input — any JSON value; absent = script sees undefined. */
	args?: unknown;
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

	const body = (await request.json().catch(() => ({}))) as ExecuteScriptBody;
  const script = typeof body.script === "string" ? body.script : "";
	if (!script.trim()) {
    return json({ error: "script is required" }, { status: 400 });
	}
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

	const app = getApplicationAdapters();

  // Resolve the owner before creating the ephemeral workspace-scoped row.
  let principalResult;
  try {
    const sessionId = request.headers.get("x-wfb-session-id")?.trim();
    principalResult = await resolveInternalWorkflowPrincipal(
      request,
      app.internalWorkflowPrincipal,
      {
        requiredScope: "workflow:execute",
        ...(sessionId
          ? { legacyResource: { kind: "session" as const, id: sessionId } }
          : {}),
      },
    );
  } catch (err) {
    if (err instanceof Error && err.message === "Database not configured") {
      return json({ error: "Database not configured" }, { status: 503 });
    }
    throw err;
  }
  if (!principalResult.ok) {
    return json(
      { error: principalResult.error },
      { status: principalResult.status },
    );
  }
  const owner = principalResult.principal;

  // Idempotency short-circuit after authentication. Verify the existing run's
  // workflow is visible in this workspace before returning any metadata.
	if (executionId) {
    const existing = await app.workflowExecutions
      .getById(executionId)
      .catch(() => null);
		if (existing) {
      const scopedWorkflow = await app.workflowData.getScopedWorkflowById({
        workflowId: existing.workflowId,
        userId: owner.userId,
        projectId: owner.projectId,
      });
      if (!scopedWorkflow) {
        return json({ error: "Execution not found" }, { status: 404 });
      }
			return json({
				executionId: existing.id,
				instanceId: existing.daprInstanceId ?? null,
				workflowId: existing.workflowId,
        reused: true,
			});
		}
	}

	// Upsert the ephemeral PRIVATE dynamic-script workflow. createWorkflow validates
	// the script (evaluator-truth) and stamps meta/estimatedAgentCalls into spec.meta;
	// a 400 here surfaces the validation reason to the caller.
  const staticMeta = extractStaticMeta(script) ?? {
    name: "Inline dynamic script",
  };
	const created = await app.workflowDefinitionCommands.createWorkflow({
		body: {
			name: staticMeta.name,
			nodes: [],
			edges: [],
      engineType: "dynamic-script",
      spec: { engine: "dynamic-script", script, meta: staticMeta },
		},
		userId: owner.userId,
    projectId: owner.projectId,
	});
  if (created.status === "error") {
		const message =
      typeof created.body === "string"
        ? created.body
        : JSON.stringify(created.body);
		return json({ error: message }, { status: created.httpStatus });
	}
	const workflow = created.body as { id: string };

	const budgetTotal =
    typeof body.budgetTotal === "number" && Number.isFinite(body.budgetTotal)
			? body.budgetTotal
			: undefined;
	const result = await startWorkflowRun({
		workflowId: workflow.id,
		// Verbatim any-JSON args; undefined = not provided (script sees undefined).
		triggerData: body.args,
		userId: owner.userId,
    projectId: owner.projectId,
		...(budgetTotal !== undefined ? { budgetTotal } : {}),
    ...(executionId ? { executionId, idempotent: true } : {}),
	});
	if (!result.ok) {
		if (result.status >= 500) {
      console.error(
        "[internal/agent/workflows/execute-script] Failed:",
        result.error,
      );
		}
		return json({ error: result.error }, { status: result.status });
	}

	return json({
		executionId: result.executionId,
		instanceId: result.instanceId,
    workflowId: result.workflowId,
	});
};

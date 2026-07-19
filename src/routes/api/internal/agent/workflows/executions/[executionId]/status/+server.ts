import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
  validateInternalOrPreviewControlRead,
  validateInternalToken,
} from "$lib/server/internal-auth";
import { getApplicationAdapters } from "$lib/server/application";
import {
  isExecutionStatusTerminal,
  resolveExecutionStatus,
} from "$lib/server/application/workflow-execution-read-model";
import { daprFetch, getOrchestratorUrl } from "$lib/server/dapr-client";
import { resolveInternalWorkflowPrincipal } from "../../../../../workflow-mcp-principal";

/**
 * GET /api/internal/agent/workflows/executions/[executionId]/status
 *
 * Returns execution status from DB + orchestrator runtime.
 * Security: service-internal auth or the tuple-bound preview read capability.
 */
export const GET: RequestHandler = async ({ request, params }) => {
	if (!validateInternalOrPreviewControlRead(request)) {
    return error(401, "Unauthorized");
	}

	const { executionId } = params;
  const app = getApplicationAdapters();
  const workflowData = app.workflowData;
  const internalRequest = validateInternalToken(request);

	let execution: Awaited<ReturnType<typeof workflowData.getExecutionById>>;
  let internalPrincipal: { userId: string; projectId: string } | null = null;
	try {
    if (internalRequest) {
      const principalResult = await resolveInternalWorkflowPrincipal(
        request,
        app.internalWorkflowPrincipal,
        {
          requiredScope: "workflow:read",
          legacyResource: {
            kind: "workflow_execution",
            id: executionId,
          },
        },
      );
      if (!principalResult.ok) {
        return error(principalResult.status, principalResult.error);
      }
      internalPrincipal = principalResult.principal;
      execution = await workflowData.getScopedExecutionById({
        executionId,
        userId: internalPrincipal.userId,
        projectId: internalPrincipal.projectId,
      });
    } else {
      // The preview capability is already bound to the local preview tuple. Its
      // database contains only that isolated preview's executions.
		execution = await workflowData.getExecutionById(executionId);
    }
	} catch (err) {
    if (err instanceof Error && err.message === "Database not configured") {
      return error(503, "Database not configured");
		}
		throw err;
	}

	if (!execution) {
    return error(404, "Execution not found");
	}

  const workflow = internalPrincipal
    ? await workflowData.getScopedWorkflowById({
        workflowId: execution.workflowId,
        userId: internalPrincipal.userId,
        projectId: internalPrincipal.projectId,
      })
    : await workflowData.getWorkflowByRef({
		workflowId: execution.workflowId,
        lookup: "id",
	});

	// Query orchestrator for live runtime status
	let runtime: Record<string, unknown> | null = null;

	if (execution.daprInstanceId) {
		try {
      const orchestratorUrl =
        workflow?.daprOrchestratorUrl || getOrchestratorUrl();
			const res = await daprFetch(
        `${orchestratorUrl}/api/v2/workflows/${execution.daprInstanceId}/status`,
			);
			if (res.ok) {
				runtime = await res.json();
			}
		} catch {
			// Orchestrator not reachable - return DB-only status
		}
	}

	// Map runtime status to local status
	let effectiveStatus = execution.status;
	let effectiveError = execution.error;
	const rowIsTerminal = isExecutionStatusTerminal(execution.status);

	if (runtime) {
    const runtimeStatus = (runtime.runtimeStatus as string) || "";
		effectiveStatus = resolveExecutionStatus(runtimeStatus, execution.status);
		if (!rowIsTerminal && runtime.error) {
			effectiveError = String(runtime.error);
		}

		// Sync DB if status diverged
		const shouldComplete =
      effectiveStatus === "success" ||
      effectiveStatus === "error" ||
      effectiveStatus === "cancelled";

		// Never rewrite a terminal row: the dynamic-script engine leaves Dapr custom
		// status at a stale phase/progress after completion, so post-terminal polls
		// must not clobber the persisted final state (mirrors the running/pending-only
		// refresh in workflow-execution-read-model).
		if (
			!rowIsTerminal &&
			(effectiveStatus !== execution.status ||
				(runtime.phase as string | null) !== execution.phase ||
				(runtime.progress as number | null) !== execution.progress)
		) {
			await workflowData.updateExecutionReadModel(execution.id, {
				status: effectiveStatus,
				phase: (runtime.phase as string) ?? execution.phase,
				progress: (runtime.progress as number) ?? execution.progress,
				// Runtime outputs only fill a missing output; never replace a persisted one.
        output:
          execution.output ??
          (runtime.outputs as Record<string, unknown>) ??
          null,
				error: effectiveError,
        ...(shouldComplete && !execution.completedAt
          ? { completedAt: new Date() }
          : {}),
			});
		}
	}

	return json({
		success: true,
		execution: {
			id: execution.id,
			workflowId: execution.workflowId,
			userId: execution.userId,
			status: effectiveStatus,
			phase: execution.phase,
			progress: execution.progress,
			error: effectiveError,
			input: execution.input,
			output: execution.output,
			daprInstanceId: execution.daprInstanceId,
			startedAt: execution.startedAt?.toISOString() ?? null,
			completedAt: execution.completedAt?.toISOString() ?? null,
			workflow: workflow
				? {
						id: workflow.id,
						name: workflow.name,
						daprOrchestratorUrl: workflow.daprOrchestratorUrl,
            engineType: workflow.engineType,
					}
        : null,
		},
		runtime,
		status: effectiveStatus,
    error: effectiveError,
	});
};

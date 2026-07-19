import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
  validateInternalOrPreviewControlRead,
  validateInternalToken,
} from "$lib/server/internal-auth";
import { getApplicationAdapters } from "$lib/server/application";
import {
	resolveExecutionStatusSnapshot,
	workflowExecutionStatusSnapshotFromRecord,
	type WorkflowRuntimeExecutionStatusSnapshot,
} from "$lib/server/application/workflow-execution-read-model";
import { daprFetch, getOrchestratorUrl } from "$lib/server/dapr-client";
import { resolveInternalWorkflowPrincipal } from "../../../../../workflow-mcp-principal";

function normalizeRuntimeStatus(
  runtime: Record<string, unknown>,
): WorkflowRuntimeExecutionStatusSnapshot {
  return {
    runtimeStatus:
      typeof runtime.runtimeStatus === "string" ? runtime.runtimeStatus : null,
    phase: typeof runtime.phase === "string" ? runtime.phase : null,
    progress:
      typeof runtime.progress === "number" && Number.isFinite(runtime.progress)
        ? runtime.progress
        : null,
    outputs: runtime.outputs ?? null,
    error: typeof runtime.error === "string" ? runtime.error : null,
    completedAt:
      typeof runtime.completedAt === "string" ? runtime.completedAt : null,
  };
}

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

	const resolved = resolveExecutionStatusSnapshot({
		persisted: execution,
		runtime: runtime ? normalizeRuntimeStatus(runtime) : null,
		observedAt: new Date(),
	});
	let snapshot = resolved.snapshot;
	if (resolved.patch) {
		const winner = await workflowData.compareAndSetExecutionReadModel({
			executionId: execution.id,
			expectedStatus: execution.status,
			patch: resolved.patch,
		});
		if (!winner) return error(404, "Execution not found");
		snapshot = workflowExecutionStatusSnapshotFromRecord(winner);
	}

	return json({
		success: true,
		execution: {
			id: execution.id,
			workflowId: execution.workflowId,
			userId: execution.userId,
			status: snapshot.status,
			phase: snapshot.phase,
			progress: snapshot.progress,
			error: snapshot.error,
			input: execution.input,
			output: snapshot.output,
			daprInstanceId: execution.daprInstanceId,
			startedAt: execution.startedAt?.toISOString() ?? null,
			completedAt: snapshot.completedAt?.toISOString() ?? null,
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
		status: snapshot.status,
		error: snapshot.error,
	});
};

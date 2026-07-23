import type { WorkflowExecutionRepository } from "$lib/server/application/ports";
import type { VclusterPreviewRecord } from "$lib/types/dev-previews";

export type PreviewParentWorkflowUse =
  | Readonly<{ state: "unbound" }>
  | Readonly<{ state: "inactive"; executionId: string }>
  | Readonly<{
      state: "active" | "unverified";
      executionId: string | null;
      detail: string;
    }>;

/**
 * Resolve the trusted host workflow stamped by the preview lifecycle launcher.
 * Destructive callers fail closed for workflow-bound previews when that owner
 * cannot be proved terminal.
 */
export async function inspectPreviewParentWorkflowUse(
  preview: VclusterPreviewRecord,
  executions: Pick<WorkflowExecutionRepository, "getById">,
): Promise<PreviewParentWorkflowUse> {
  if (preview.origin?.kind !== "workflow") return { state: "unbound" };

  const executionId = preview.origin.reference?.trim() ?? "";
  if (!executionId) {
    return {
      state: "unverified",
      executionId: null,
      detail: "workflow-bound preview has no parent execution reference",
    };
  }

  let execution: Awaited<ReturnType<typeof executions.getById>>;
  try {
    execution = await executions.getById(executionId);
  } catch (cause) {
    return {
      state: "unverified",
      executionId,
      detail: `parent workflow status is unavailable: ${errorDetail(cause)}`,
    };
  }
  if (!execution) {
    return {
      state: "unverified",
      executionId,
      detail: "parent workflow execution was not found",
    };
  }
  if (execution.status === "pending" || execution.status === "running") {
    return {
      state: "active",
      executionId,
      detail: `parent workflow is ${execution.status}`,
    };
  }
  return { state: "inactive", executionId };
}

function errorDetail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export type WorkflowLaunchSurface = "generic" | "dev-environment";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolve the presentation surface declared by workflow-owned metadata. */
export function getWorkflowLaunchSurface(spec: unknown): WorkflowLaunchSurface {
  if (!isRecord(spec)) return "generic";
  const document = isRecord(spec.document) ? spec.document : null;
  const workflowBuilder =
    document && isRecord(document["x-workflow-builder"])
      ? document["x-workflow-builder"]
      : null;
  const launch =
    workflowBuilder && isRecord(workflowBuilder.launch)
      ? workflowBuilder.launch
      : null;
  return launch?.surface === "dev-environment" ? "dev-environment" : "generic";
}

export function workflowLaunchHref(
  surface: WorkflowLaunchSurface,
  workspaceSlug: string,
): string | null {
  if (surface !== "dev-environment") return null;
  return `/workspaces/${encodeURIComponent(workspaceSlug)}/dev?launch=1`;
}

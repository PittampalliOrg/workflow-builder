export type WorkflowLaunchSurface = "generic" | "dev-environment";
export type WorkflowLaunchTarget = "any" | "control-plane";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolve the presentation surface declared by workflow-owned metadata. */
export function getWorkflowLaunchSurface(spec: unknown): WorkflowLaunchSurface {
  if (!isRecord(spec)) return "generic";
	const dynamicMeta = spec.engine === "dynamic-script" && isRecord(spec.meta) ? spec.meta : null;
	const dynamicLaunch = dynamicMeta && isRecord(dynamicMeta.launch) ? dynamicMeta.launch : null;
	if (dynamicLaunch?.surface === "dev-environment") return "dev-environment";

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

/** Resolve an optional deployment target for a workflow-owned launch surface. */
export function getWorkflowLaunchTarget(spec: unknown): WorkflowLaunchTarget {
	if (!isRecord(spec)) return "any";
	const dynamicMeta = spec.engine === "dynamic-script" && isRecord(spec.meta) ? spec.meta : null;
	const dynamicLaunch = dynamicMeta && isRecord(dynamicMeta.launch) ? dynamicMeta.launch : null;
	return dynamicLaunch?.target === "control-plane" ? "control-plane" : "any";
}

export function workflowLaunchHref(
  surface: WorkflowLaunchSurface,
  workspaceSlug: string,
): string | null {
  if (surface !== "dev-environment") return null;
  return `/workspaces/${encodeURIComponent(workspaceSlug)}/dev?launch=1`;
}

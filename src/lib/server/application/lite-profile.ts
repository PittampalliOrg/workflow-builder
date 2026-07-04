/**
 * Shared markers for the lite profile's honest workflow-scheduler stub.
 *
 * The lite scheduler cannot run a workflow — durable execution lives in the
 * Python orchestrator + Dapr placement, which the lite profile does not run.
 * It returns an instance id with this prefix so the execution read-model can
 * render an explicit "requires a preview environment" state instead of leaving
 * the run stuck in "running" forever.
 */
export const LITE_WORKFLOW_INSTANCE_PREFIX = "lite-";

export function isLiteWorkflowInstanceId(id: string | null | undefined): boolean {
	return typeof id === "string" && id.startsWith(LITE_WORKFLOW_INSTANCE_PREFIX);
}

export const LITE_WORKFLOW_NOT_EXECUTED_MESSAGE =
	"Workflow execution requires a preview environment — the workflow orchestrator does not run in the lite profile (APP_PROFILE=lite).";

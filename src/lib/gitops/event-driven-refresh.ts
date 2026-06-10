import type { GitOpsActivityEvent } from "$lib/types/gitops-activity";

const REFRESH_RESOURCES = new Set([
	"applications",
	"pipelineruns",
	"taskruns",
	"promotionstrategies",
	"changetransferpolicies",
	"pullrequests",
	"commitstatuses",
	"argocdcommitstatuses",
	"timedcommitstatuses",
]);

const REFRESH_KINDS = new Set([
	"application",
	"pipelinerun",
	"taskrun",
	"promotionstrategy",
	"changetransferpolicy",
	"pullrequest",
	"commitstatus",
	"argocdcommitstatus",
	"timedcommitstatus",
]);

export const GITOPS_EVENT_REFRESH_DEBOUNCE_MS = 1_500;

/**
 * Shared merge for the activity-event buffer: dedupe by `eventId` (incoming
 * wins), sort newest-first by `sequence`, cap to `limit`.
 */
export function mergeActivityEvents(
	current: GitOpsActivityEvent[],
	incoming: GitOpsActivityEvent[],
	limit = 300,
): GitOpsActivityEvent[] {
	const byId = new Map(current.map((e) => [e.eventId, e]));
	for (const e of incoming) byId.set(e.eventId, e);
	return [...byId.values()].sort((a, b) => b.sequence - a.sequence).slice(0, limit);
}

export function gitOpsDeploymentMetadataUrl(options: { fresh?: boolean } = {}): string {
	return options.fresh
		? "/api/v1/gitops/deployment-metadata?fresh=1"
		: "/api/v1/gitops/deployment-metadata";
}

/**
 * The hub inventory ConfigMap update event — the signal that a freshly
 * generated inventory snapshot is available. It drives a metadata refresh but
 * is kept OUT of the user-visible activity feed (it fires ~1/min and carries
 * no per-app story). The resourceRef-name fallback covers events ingested
 * before the server-side `gitops.inventory` classification deployed.
 */
export function isInventoryActivityEvent(event: GitOpsActivityEvent): boolean {
	if (event.activityType === "gitops.inventory") return true;
	return (
		event.resourceRef.kind?.toLowerCase() === "configmap" &&
		event.resourceRef.name === "gitops-deployment-inventory"
	);
}

export function shouldRefreshGitOpsMetadata(event: GitOpsActivityEvent): boolean {
	if (isInventoryActivityEvent(event)) return true;

	const resource = event.resourceRef.resource?.toLowerCase();
	if (resource && REFRESH_RESOURCES.has(resource)) return true;

	const kind = event.resourceRef.kind?.toLowerCase();
	if (kind && REFRESH_KINDS.has(kind)) return true;

	const source = event.source.toLowerCase();
	return source.includes("tekton") || source.includes("promoter") || source.includes("argocd");
}

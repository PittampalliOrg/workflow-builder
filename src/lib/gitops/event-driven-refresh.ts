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

export function shouldRefreshGitOpsMetadata(event: GitOpsActivityEvent): boolean {
	const resource = event.resourceRef.resource?.toLowerCase();
	if (resource && REFRESH_RESOURCES.has(resource)) return true;

	const kind = event.resourceRef.kind?.toLowerCase();
	if (kind && REFRESH_KINDS.has(kind)) return true;

	const source = event.source.toLowerCase();
	return source.includes("tekton") || source.includes("promoter") || source.includes("argocd");
}

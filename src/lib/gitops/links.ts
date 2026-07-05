// External-tool link sets for the GitOps surface, shared by the route load(s)
// and the lib components that render them (promoter Pipeline/Timeline/Inbox
// views, ServiceDetail, ServicesTab). Kept here (not in the route `+page.server`
// module) so components import a $lib type instead of reaching back into a route.

export type GitopsPageLinks = {
	tektonBase: string | null;
	stacksRepo: string;
	workflowBuilderRepo: string;
	argoCdBase: string;
	headlampBase: string;
	headlampWorkspaceSlug: string;
	ghcrOrg: string;
	releasePinsPath: string;
};

/** Superset used by the pipeline overview (adds Tekton webhook, GHCR package
 * index, inventory, and per-env workflow-builder deep links). */
export type GitopsSystemPageLinks = {
	tektonBase: string | null;
	stacksRepo: string;
	workflowBuilderRepo: string;
	argoCdBase: string;
	headlampBase: string;
	ghcrOrg: string;
	ghcrPackages: string;
	releasePinsPath: string;
	deploymentInventory: string;
	workflowBuilderRyzen: string;
	workflowBuilderDev: string;
	tektonWebhook: string;
};

import { env } from "$env/dynamic/public";

import { DEFAULT_HEADLAMP_URL } from "$lib/headlamp/links";
import type { GitopsPageLinks, GitopsSystemPageLinks } from "$lib/gitops/links";
import { mapPrPreviewStatuses } from "$lib/gitops/pr-preview-summary";
import type { GitOpsPrPreviewSummary } from "$lib/gitops/pr-preview-summary";
import { getApplicationAdapters } from "$lib/server/application";
import { getApplicationAdapterConfig } from "$lib/server/application/config";

import type { PageServerLoad } from "./$types";

export type { GitopsPageLinks };

export const load: PageServerLoad = async ({ locals }) => {
	const adapters = getApplicationAdapters();
	const { gitOpsActivityEvents, gitOpsDeployment, gitOpsPromotions } = adapters;
	const config = getApplicationAdapterConfig();
	const [initial, promotions, activityEvents, prPreviews] = await Promise.all([
		gitOpsDeployment.getMetadata(),
		gitOpsPromotions.getStrategies(),
		gitOpsActivityEvents.list({ limit: 200 }),
		loadPrPreviews(adapters, config),
	]);
	const tektonBase =
		env.PUBLIC_TEKTON_DASHBOARD_URL?.trim() ||
		"https://tekton-dashboard-hub.tail286401.ts.net";
	const argoCdBase =
		env.PUBLIC_ARGOCD_URL?.trim() || "https://argocd-hub.tail286401.ts.net";
	const headlampBase =
		env.PUBLIC_HEADLAMP_EXTERNAL_URL?.trim() ||
		env.PUBLIC_HEADLAMP_URL?.trim() ||
		DEFAULT_HEADLAMP_URL;
	const stacksRepo = "https://github.com/PittampalliOrg/stacks";
	const workflowBuilderRepo = "https://github.com/PittampalliOrg/workflow-builder";
	const ghcrOrg = "https://github.com/orgs/PittampalliOrg/packages/container/package";
	const releasePinsPath =
		"packages/components/hub-spoke-appsets/release-pins/workflow-builder-images.yaml";
	// Promoter tabs (pipelines/inbox/timeline/services) links.
	const links: GitopsPageLinks = {
		tektonBase,
		stacksRepo,
		workflowBuilderRepo,
		argoCdBase,
		headlampBase,
		headlampWorkspaceSlug: "default",
		ghcrOrg,
		releasePinsPath,
	};
	// Overview tab (the former /system pipeline experience) links.
	const overviewLinks: GitopsSystemPageLinks = {
		tektonBase,
		stacksRepo,
		workflowBuilderRepo,
		argoCdBase,
		headlampBase,
		ghcrOrg,
		ghcrPackages:
			"https://github.com/orgs/PittampalliOrg/packages?repo_name=workflow-builder",
		releasePinsPath,
		deploymentInventory: "https://gitops-inventory-hub.tail286401.ts.net/inventory.json",
		workflowBuilderRyzen: "https://workflow-builder-ryzen.tail286401.ts.net",
		workflowBuilderDev: "https://workflow-builder-dev.tail286401.ts.net",
		tektonWebhook: "https://tekton-hub.tail286401.ts.net/",
	};
	return {
		initial,
		promotions,
		activityEvents,
		prPreviews,
		tektonBase,
		links,
		overviewLinks,
		viewerEmail: locals.session?.email ?? null,
	};
};

/** Resume-safe per-PR preview snapshots for the pr-preview lane. Flag-gated
 * (off → empty); a failed read degrades to empty. NEVER calls `.status()`. */
async function loadPrPreviews(
	adapters: ReturnType<typeof getApplicationAdapters>,
	config: ReturnType<typeof getApplicationAdapterConfig>,
): Promise<GitOpsPrPreviewSummary[]> {
	if (!config.prPreviewsEnabled) return [];
	const statuses = await adapters.prPreviews.listStatuses().catch(() => []);
	return mapPrPreviewStatuses(statuses, config.prPreviewRepo);
}

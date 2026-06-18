import { env } from "$env/dynamic/public";

import { DEFAULT_HEADLAMP_URL } from "$lib/headlamp/links";
import { listGitOpsActivityEvents } from "$lib/server/gitops/activity-events";
import { getDeploymentMetadata } from "$lib/server/gitops/deployment-metadata";
import { getPromotionStrategies } from "$lib/server/promoter";

import type { PageServerLoad } from "./$types";

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

export const load: PageServerLoad = async ({ locals }) => {
	const [initial, promotions, activityEvents] = await Promise.all([
		getDeploymentMetadata(),
		getPromotionStrategies(),
		listGitOpsActivityEvents({ limit: 200 }),
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
	const links: GitopsSystemPageLinks = {
		tektonBase,
		stacksRepo: "https://github.com/PittampalliOrg/stacks",
		workflowBuilderRepo: "https://github.com/PittampalliOrg/workflow-builder",
		argoCdBase,
		headlampBase,
		ghcrOrg: "https://github.com/orgs/PittampalliOrg/packages/container/package",
		ghcrPackages: "https://github.com/orgs/PittampalliOrg/packages?repo_name=workflow-builder",
		releasePinsPath:
			"packages/components/hub-spoke-appsets/release-pins/workflow-builder-images.yaml",
		deploymentInventory: "https://gitops-inventory-hub.tail286401.ts.net/inventory.json",
		workflowBuilderRyzen: "https://workflow-builder-ryzen.tail286401.ts.net",
		workflowBuilderDev: "https://workflow-builder-dev.tail286401.ts.net",
		tektonWebhook: "https://tekton-hub.tail286401.ts.net/",
	};
	return {
		initial,
		promotions,
		activityEvents,
		links,
		viewerEmail: locals.session?.email ?? null,
	};
};

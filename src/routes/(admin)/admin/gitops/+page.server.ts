import { env } from "$env/dynamic/public";

import { getDeploymentMetadata } from "$lib/server/gitops/deployment-metadata";
import { getPromotionStrategies } from "$lib/server/promoter";

import type { PageServerLoad } from "./$types";

export type GitopsPageLinks = {
	tektonBase: string | null;
	stacksRepo: string;
	workflowBuilderRepo: string;
	argoCdBase: string;
	ghcrOrg: string;
	releasePinsPath: string;
};

export const load: PageServerLoad = async () => {
	const [initial, promotions] = await Promise.all([
		getDeploymentMetadata(),
		getPromotionStrategies(),
	]);
	const tektonBase =
		env.PUBLIC_TEKTON_DASHBOARD_URL?.trim() ||
		"https://tekton-dashboard-hub.tail286401.ts.net";
	const argoCdBase =
		env.PUBLIC_ARGOCD_URL?.trim() || "https://argocd-hub.tail286401.ts.net";
	const links: GitopsPageLinks = {
		tektonBase,
		stacksRepo: "https://github.com/PittampalliOrg/stacks",
		workflowBuilderRepo: "https://github.com/PittampalliOrg/workflow-builder",
		argoCdBase,
		ghcrOrg: "https://github.com/orgs/PittampalliOrg/packages/container/package",
		releasePinsPath:
			"packages/components/hub-spoke-appsets/release-pins/workflow-builder-images.yaml",
	};
	return {
		initial,
		promotions,
		tektonBase,
		links,
	};
};

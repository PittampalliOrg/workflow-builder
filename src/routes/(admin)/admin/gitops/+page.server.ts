import { env } from "$env/dynamic/public";

import { DEFAULT_HEADLAMP_URL } from "$lib/headlamp/links";
import { getApplicationAdapters } from "$lib/server/application";

import type { PageServerLoad } from "./$types";

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

export const load: PageServerLoad = async () => {
	const { gitOpsDeployment, gitOpsPromotions } = getApplicationAdapters();
	const [initial, promotions] = await Promise.all([
		gitOpsDeployment.getMetadata(),
		gitOpsPromotions.getStrategies(),
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
	const links: GitopsPageLinks = {
		tektonBase,
		stacksRepo: "https://github.com/PittampalliOrg/stacks",
		workflowBuilderRepo: "https://github.com/PittampalliOrg/workflow-builder",
		argoCdBase,
		headlampBase,
		headlampWorkspaceSlug: "default",
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

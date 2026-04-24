import { env } from "$env/dynamic/public";

import { getDeploymentMetadata } from "$lib/server/gitops/deployment-metadata";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => {
	const initial = await getDeploymentMetadata();
	const tektonBase =
		env.PUBLIC_TEKTON_DASHBOARD_URL?.trim() || null;
	return {
		initial,
		tektonBase,
	};
};

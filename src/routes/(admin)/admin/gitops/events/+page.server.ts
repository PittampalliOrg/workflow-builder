import { listGitOpsActivityEvents } from "$lib/server/gitops/activity-events";

import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => {
	const events = await listGitOpsActivityEvents({ limit: 500 });
	return {
		events,
		generatedAt: new Date().toISOString(),
	};
};

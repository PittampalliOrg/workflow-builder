import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

import { getApplicationAdapters } from "$lib/server/application";
import {
	enrichLiveCommits,
	getDeploymentMetadata,
} from "$lib/server/gitops/deployment-metadata";

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	try {
		const isAdmin = await getApplicationAdapters().workflowData.isPlatformAdmin(
			locals.session.userId,
		);
		if (!isAdmin) return error(403, "Admin access required");
	} catch (err) {
		if (err instanceof Error && err.message.includes("Database not configured")) {
			return error(500, "Database not configured");
		}
		throw err;
	}

	const fresh = url.searchParams.get("fresh") === "1" || url.searchParams.get("fresh") === "true";
	const metadata = await enrichLiveCommits(await getDeploymentMetadata({ fresh }));
	return json(metadata);
};

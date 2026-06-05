import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

import { ingestGitOpsActivityEvent } from "$lib/server/gitops/activity-events";
import { invalidateGitOpsDeploymentMetadataCaches } from "$lib/server/gitops/deployment-metadata";
import { requireInternal } from "$lib/server/internal-auth";

export const POST: RequestHandler = async ({ request }) => {
	requireInternal(request);

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return error(400, "Expected JSON body");
	}

	const event = await ingestGitOpsActivityEvent(body);
	invalidateGitOpsDeploymentMetadataCaches();
	return json({ event }, { status: 202 });
};

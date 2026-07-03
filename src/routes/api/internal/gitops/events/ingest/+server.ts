import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

import { getApplicationAdapters } from "$lib/server/application";
import {
	invalidateGitOpsPinCaches,
	invalidateGitOpsRuntimeCaches,
} from "$lib/server/gitops/deployment-metadata";
import { requireInternal } from "$lib/server/internal-auth";

// Activity types whose arrival means cluster state may have moved — clear the
// cheap runtime caches (hub inventory + runtime metadata) so the next metadata
// fetch sees it. The expensive GitHub-derived pin caches are only cleared on
// pin-affecting signals (a promotion PR is what edits release-pins/env
// branches); blanket invalidation here used to re-trigger the 50-commit pin
// history walk on every event burst.
const RUNTIME_CACHE_ACTIVITY_TYPES = new Set([
	"gitops.inventory",
	"argocd.application",
	"tekton.pipelinerun",
	"tekton.taskrun",
	"promoter.promotionstrategy",
	"promoter.changetransferpolicy",
	"promoter.commitstatus",
]);

export const POST: RequestHandler = async ({ request }) => {
	requireInternal(request);

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return error(400, "Expected JSON body");
	}

	const event = await getApplicationAdapters().gitOpsActivityEvents.ingest(body);
	if (event.activityType === "promoter.pullrequest") {
		invalidateGitOpsPinCaches();
		invalidateGitOpsRuntimeCaches();
	} else if (RUNTIME_CACHE_ACTIVITY_TYPES.has(event.activityType)) {
		invalidateGitOpsRuntimeCaches();
	}
	return json({ event }, { status: 202 });
};

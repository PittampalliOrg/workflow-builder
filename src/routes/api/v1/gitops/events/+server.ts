import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

import { getApplicationAdapters } from "$lib/server/application";
import { requirePlatformAdmin } from "$lib/server/platform-admin";
import type { GitOpsActivityEventsResponse } from "$lib/types/gitops-activity";

export const GET: RequestHandler = async ({ locals, url }) => {
	await requirePlatformAdmin(locals);

	const since = url.searchParams.get("since");
	const limit = Number.parseInt(url.searchParams.get("limit") ?? "200", 10);
	const afterSequence = /^\d+$/.test(since ?? "") ? Number(since) : null;
	const events = await getApplicationAdapters().gitOpsActivityEvents.list({
		since,
		afterSequence,
		limit,
	});
	const body: GitOpsActivityEventsResponse = {
		generatedAt: new Date().toISOString(),
		events,
	};
	return json(body);
};

import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { validatePreviewGovernanceDispatchToken } from "$lib/server/internal-auth";
import { getApplicationAdapters } from "$lib/server/application";
import { getApplicationAdapterConfig } from "$lib/server/application/config";

/**
 * GET /api/internal/pr-previews/[prNumber] — PR-preview status (D1).
 *
 * Polled by the hub Tekton dispatch Task until `state` is `ready`, `error`, or
 * `capacity_full` (then it posts the GitHub commit status + sticky comment).
 */
export const GET: RequestHandler = async ({ request, params }) => {
	if (!getApplicationAdapterConfig().prPreviewsEnabled) {
		return json({ error: "PR previews are not enabled" }, { status: 404 });
	}
	if (!validatePreviewGovernanceDispatchToken(request)) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}
	const prNumber = Number(params.prNumber);
	if (!Number.isInteger(prNumber) || prNumber <= 0) {
		return json({ error: "a positive integer prNumber is required" }, { status: 400 });
	}
	const status = await getApplicationAdapters().prPreviews.status(prNumber);
	return json(status);
};

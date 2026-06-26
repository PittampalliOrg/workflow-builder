import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { reapResumableWorkspaces } from "$lib/server/lifecycle/resumable-workspace-reaper";

/**
 * POST /api/internal/lifecycle/reap-resumable-workspaces
 *
 * Driven by the stacks `resumable-workspace-gc` CronJob. Reclaims JuiceFS data for
 * resumable workspaces whose run is terminal + aged + not superseded by an active
 * fork. Destructive → strictly gated; internal-token only. Body:
 * { olderThanHours?, limit?, dryRun? }.
 */
export const POST: RequestHandler = async ({ request }) => {
	requireInternal(request);
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const olderThanHours =
		typeof body.olderThanHours === "number" ? body.olderThanHours : undefined;
	const limit = typeof body.limit === "number" ? body.limit : undefined;
	const dryRun = body.dryRun === true;
	const result = await reapResumableWorkspaces({ olderThanHours, limit, dryRun });
	return json(result);
};

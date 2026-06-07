import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { reapTerminalRuns } from "$lib/server/lifecycle/reaper";

/**
 * POST /api/internal/lifecycle/reap-terminal
 *
 * Driven by the stacks `lifecycle-terminal-reaper` CronJob. Reconciles DB rows
 * stuck non-terminal against terminal/gone Dapr instances and purges the
 * orphans via the lifecycle controller. Divergence-safe (never kills a live
 * run) and skips while a benchmark run is active. Internal-token gated.
 */
export const POST: RequestHandler = async ({ request }) => {
	requireInternal(request);
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const olderThanMinutes =
		typeof body.olderThanMinutes === "number" ? body.olderThanMinutes : undefined;
	const limit = typeof body.limit === "number" ? body.limit : undefined;
	const result = await reapTerminalRuns({ olderThanMinutes, limit });
	return json(result);
};

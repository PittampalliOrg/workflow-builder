import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { runSessionReconcile } from "$lib/server/application/session-reconciler-service";

/**
 * Internal ops / CronJob-fallback entry for the session liveness reconciler.
 * Runs one sweep and returns the decisions. `{ dryRun?, limit? }` override the
 * env config for a manual dry-run or a bounded scan. Always internal-token
 * guarded (it can converge sessions when dry-run is off).
 *
 * The Dapr Job tick calls the SAME `runSessionReconcile` via the /job callback
 * route; this endpoint ships regardless so operators (and a CronJob fallback)
 * always have a manual handle.
 */
export const POST: RequestHandler = async ({ request }) => {
	requireInternal(request);
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const dryRun = typeof body.dryRun === "boolean" ? body.dryRun : undefined;
	const limit =
		typeof body.limit === "number" && Number.isFinite(body.limit)
			? body.limit
			: undefined;
	const result = await runSessionReconcile({ dryRun, limit });
	return json(result);
};

import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { runRunArchive } from "$lib/server/application/run-archive-service";

/**
 * Internal ops entry for the archive-on-terminal sweep. Runs one sweep and
 * returns the result. `{ dryRun?, limit? }` override the env batch limit for a
 * manual dry-run or a bounded scan. Always internal-token guarded (it writes
 * durable bundles + flips archived_at when dry-run is off).
 *
 * The Dapr Job tick calls the SAME `runRunArchive` via the /job/run-archive
 * callback; this endpoint ships so operators always have a manual handle (used to
 * prove the archive lands during dev verification).
 */
export const POST: RequestHandler = async ({ request }) => {
	requireInternal(request);
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const dryRun = typeof body.dryRun === "boolean" ? body.dryRun : undefined;
	const limit =
		typeof body.limit === "number" && Number.isFinite(body.limit)
			? body.limit
			: undefined;
	const result = await runRunArchive({ dryRun, limit });
	return json(result);
};

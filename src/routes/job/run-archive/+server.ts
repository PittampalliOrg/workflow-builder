import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	authenticateRunArchiveJobPayload,
	runRunArchive,
} from "$lib/server/application/run-archive-service";

/**
 * Dapr Jobs callback for the archive-on-terminal sweep. The BFF's own daprd
 * sidecar delivers the recurring `run-archive` job here (Dapr invokes the app at
 * `POST /job/<jobName>`), the same in-sidecar delivery idiom as
 * `/job/session-liveness-reconcile`. Otherwise unauthenticated, so the delivered
 * payload carries INTERNAL_API_TOKEN (stamped at schedule time) and a mismatched/
 * absent token is rejected. Post-auth processing errors return 200 so the
 * scheduler marks the trigger delivered instead of piling up redeliveries.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => ({}));
	if (!authenticateRunArchiveJobPayload(body)) {
		throw error(401, "invalid or missing run-archive job token");
	}
	try {
		const result = await runRunArchive();
		if (!("skipped" in result)) {
			console.log(
				`[run-archive] tick: scanned=${result.scanned} archived=${result.archived.length} ` +
					`failed=${result.failed.length} dryRun=${result.dryRun}`,
			);
		}
		return json({ ok: true, ...result });
	} catch (err) {
		console.error("[run-archive] tick failed:", err);
		return json({ ok: false, error: err instanceof Error ? err.message : String(err) });
	}
};

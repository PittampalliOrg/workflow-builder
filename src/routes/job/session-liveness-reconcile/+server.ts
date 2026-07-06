import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	authenticateReconcilerJobPayload,
	runSessionReconcile,
} from "$lib/server/application/session-reconciler-service";

/**
 * Dapr Jobs callback. The BFF's own daprd sidecar delivers the recurring
 * `session-liveness-reconcile` job here (Dapr invokes the app at
 * `POST /job/<jobName>`), the same in-sidecar delivery idiom as
 * `/api/internal/dapr/sandbox-events`. This path is otherwise unauthenticated, so
 * the job's delivered payload carries INTERNAL_API_TOKEN (stamped at schedule
 * time) and we reject any callback whose token is absent/mismatched — an
 * unauthorized (re)delivery is harmless, so a 401 there is fine. Once
 * authenticated it runs ONE reconcile sweep and returns 200 for POST-AUTH
 * processing errors so the scheduler marks the trigger delivered (a 5xx would
 * make it redeliver and pile up).
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => ({}));
	if (!authenticateReconcilerJobPayload(body)) {
		throw error(401, "invalid or missing reconciler job token");
	}
	try {
		const result = await runSessionReconcile();
		if (!("skipped" in result)) {
			console.log(
				`[session-reconciler] tick: scanned=${result.scanned} actions=${result.actionsTaken} dryRun=${result.dryRun}`,
			);
		}
		return json({ ok: true, ...result });
	} catch (err) {
		console.error("[session-reconciler] tick failed:", err);
		return json({ ok: false, error: err instanceof Error ? err.message : String(err) });
	}
};

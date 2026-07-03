import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * GET /api/v1/capacity/rightsizing?windowDays=14 — per-runtime recommended
 * sandbox requests, derived from ACTUAL measured per-session peaks (P90 + 20%
 * headroom). Advisory only: apply by editing the SANDBOX_EXECUTION_CLASSES_JSON
 * render heredoc in stacks. See docs/session-resource-metrics-and-kueue-admission.md.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const raw = Number(url.searchParams.get("windowDays") ?? "14");
	const windowDays = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 90) : 14;
	const recommendations =
		await getApplicationAdapters().resourceMetrics.computeRightsizingRecommendations({
			windowDays,
		});
	return json({ windowDays, recommendations });
};

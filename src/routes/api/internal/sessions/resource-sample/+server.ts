import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { sampleAndPersistSessionResourceUsage } from "$lib/server/metrics/session-usage";

/**
 * POST /api/internal/sessions/resource-sample — one resource-sampling tick.
 * Reads live per-pod CPU/mem (metrics-server) and accumulates peak/avg into
 * each live session's `usage.resource`. Internal-token gated; driven by the
 * `session-resource-sample` CronJob (stacks). Idempotent enough to run on a
 * fixed cadence. See docs/session-resource-metrics-and-kueue-admission.md.
 */
export const POST: RequestHandler = async ({ request }) => {
	requireInternal(request);
	const result = await sampleAndPersistSessionResourceUsage();
	return json({ ok: true, ...result });
};

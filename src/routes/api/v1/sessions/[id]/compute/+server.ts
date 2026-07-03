import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * GET /api/v1/sessions/[id]/compute — live ACTUAL CPU/memory consumed by the
 * session's runtime (sandbox) pod, alongside its scheduled requests. Powers the
 * session-detail "Compute" Pulse tile (the per-session counterpart to the
 * token/cost telemetry). Polled by the UI; reads the single pod's Metrics-API
 * sample + its request spec — no namespace-wide list. Usage is `null` until
 * metrics-server has a sample (pod just booted) or once the pod is gone.
 *
 * See docs/session-resource-metrics-and-kueue-admission.md.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const sessionId = params.id!;
	const compute = await getApplicationAdapters().workflowData.getSessionRuntimeCompute({
		sessionId,
		projectId: locals.session.projectId ?? null,
		userId: locals.session.userId,
	});
	if (!compute) return error(404, "Session not found in workspace");

	return json(compute);
};

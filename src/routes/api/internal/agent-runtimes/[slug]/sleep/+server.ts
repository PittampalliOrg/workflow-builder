import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";

import { sleepAgentRuntime } from "$lib/server/kube/client";
import { requireInternal } from "$lib/server/internal-auth";

/**
 * POST /api/internal/agent-runtimes/:slug/sleep
 *
 * Manual scale-to-zero. Admin-only action from the UI. Controller's idle
 * reaper normally handles this; this endpoint lets admins free a pod
 * immediately without waiting for idleTtlSeconds to elapse.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	requireInternal(request);
	await sleepAgentRuntime(params.slug!);
	return json({ ok: true });
};

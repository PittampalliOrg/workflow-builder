import type { RequestHandler } from "./$types";
import { error, json } from "@sveltejs/kit";

import { sleepAgentRuntime } from "$lib/server/kube/client";
import { validateInternalToken } from "$lib/server/internal-auth";

function requireInternal(request: Request): void {
	if (!validateInternalToken(request)) {
		throw error(401, "invalid or missing INTERNAL_API_TOKEN");
	}
}

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

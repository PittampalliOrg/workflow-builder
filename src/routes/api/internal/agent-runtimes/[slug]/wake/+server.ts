import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";

import { wakeAgentRuntime } from "$lib/server/kube/client";
import { requireInternal } from "$lib/server/internal-auth";

/**
 * POST /api/internal/agent-runtimes/:slug/wake
 *
 * Called by:
 *  - resolver.ts at workflow dispatch time, before call_child_workflow,
 *    to ensure the target pod is Active before Dapr routes the call
 *  - the UI's agent detail page when user clicks "Wake now"
 *
 * Query params:
 *  - timeoutMs: hard ceiling (default 30000, min 5000, max 60000)
 *
 * Returns 200 with status once the runtime is Active; 504 on timeout.
 */
export const POST: RequestHandler = async ({ params, url, request }) => {
	requireInternal(request);
	const slug = params.slug!;
	const rawTimeout = Number.parseInt(url.searchParams.get("timeoutMs") ?? "", 10);
	const timeoutMs = Number.isFinite(rawTimeout)
		? Math.min(60_000, Math.max(5_000, rawTimeout))
		: 30_000;

	try {
		const status = await wakeAgentRuntime(slug, timeoutMs);
		return json({
			phase: status.phase,
			replicas: status.replicas,
			readyReplicas: status.readyReplicas,
			source: status.source,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.includes("timeout")) {
			return json({ error: message }, { status: 504 });
		}
		return json({ error: message }, { status: 500 });
	}
};

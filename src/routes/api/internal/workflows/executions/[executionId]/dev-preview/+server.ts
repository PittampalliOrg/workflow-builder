import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import {
	provisionDevPreview,
	teardownDevPreview,
} from "$lib/server/workflows/dev-preview";

/**
 * POST /api/internal/workflows/executions/[executionId]/dev-preview
 *
 * Provision (or adopt) a per-run ephemeral `vite dev` Sandbox for this workflow
 * execution and return its in-cluster address. Called by the orchestrator
 * `dev/preview` (ensure) activity. Internal-token auth.
 *
 * Body (all optional): { syncToken?, timeoutSeconds?, waitReadySeconds?, image?, executionClass? }
 * Returns: { sandboxName, podIP, port, url, ready, status }
 *
 * DELETE /api/internal/workflows/executions/[executionId]/dev-preview
 * Tears the Sandbox down (explicit teardown node / lifecycle cascade).
 */

export const POST: RequestHandler = async ({ params, request }) => {
	requireInternal(request);
	const executionId = params.executionId;
	if (!executionId) return json({ error: "executionId required" }, { status: 400 });
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	try {
		const info = await provisionDevPreview({
			executionId,
			syncToken: typeof body.syncToken === "string" ? body.syncToken : null,
			timeoutSeconds:
				typeof body.timeoutSeconds === "number" ? body.timeoutSeconds : null,
			waitReadySeconds:
				typeof body.waitReadySeconds === "number"
					? body.waitReadySeconds
					: undefined,
			image: typeof body.image === "string" ? body.image : null,
			executionClass:
				typeof body.executionClass === "string"
					? body.executionClass
					: undefined,
		});
		return json(info);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error("[dev-preview] provision failed:", message);
		return json({ error: message }, { status: 503 });
	}
};

export const DELETE: RequestHandler = async ({ params, request, url }) => {
	requireInternal(request);
	const executionId = params.executionId;
	if (!executionId) return json({ error: "executionId required" }, { status: 400 });
	const sandboxName = url.searchParams.get("sandboxName");
	const result = await teardownDevPreview({ executionId, sandboxName });
	return json(result);
};

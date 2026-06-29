/**
 * POST /api/internal/workflows/executions/[executionId]/dev-preview/snapshot
 *
 * Internal-only: capture a durable, promotable version of the code a
 * dev-pod-as-source run has produced SO FAR by pulling the dev pod's `/__export`
 * and storing it as a `source-bundle` (tier `tar-overlay`). A GAN fixture calls
 * this once per loop iteration (after `generate`) so EVERY iteration's design is
 * promotable (the deterministic id includes `iteration`). Best-effort — never
 * fails the run. Auth: requires INTERNAL_API_TOKEN.
 */

import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { captureDevPreviewSource } from "$lib/server/workflows/dev-preview";

type Body = {
	nodeId?: string | null;
	iteration?: number | string | null;
};

export const POST: RequestHandler = async ({ params, request }) => {
	requireInternal(request);
	const { executionId } = params;
	if (!executionId) return json({ ok: false, error: "executionId required" }, { status: 400 });

	let body: Body = {};
	try {
		body = (await request.json()) as Body;
	} catch {
		/* empty body is fine */
	}
	const iterationRaw = body.iteration;
	const iteration =
		iterationRaw == null || iterationRaw === ""
			? null
			: Number.parseInt(String(iterationRaw), 10);

	const result = await captureDevPreviewSource(executionId, {
		nodeId: body.nodeId ?? "dev-preview",
		iteration: Number.isFinite(iteration as number) ? (iteration as number) : null,
	});
	return json(result);
};

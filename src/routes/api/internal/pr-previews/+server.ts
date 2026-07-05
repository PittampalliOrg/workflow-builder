import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { validateInternalToken } from "$lib/server/internal-auth";
import { getApplicationAdapters } from "$lib/server/application";
import { getApplicationAdapterConfig } from "$lib/server/application/config";

/**
 * POST /api/internal/pr-previews — label-gated per-PR preview dispatch (D1).
 *
 * Called by the hub Tekton `pr-preview-dispatch` Task on pull_request webhooks
 * (label `preview` gates the loop). Internal-token auth + `PR_PREVIEWS_ENABLED`
 * flag (default off → 404, mirroring preview-run-feed).
 *
 * Body: { action: "up"|"down", prNumber, headSha?, headRef?, changedFiles?, verify? }
 *  - up: idempotent — an existing `pr-<n>` preview is re-seeded, not re-provisioned;
 *    returns 202 with the current status snapshot (poll GET /api/internal/pr-previews/<n>).
 *  - down: tears down the `pr-<n>` preview (absent is fine); returns 200.
 */
export const POST: RequestHandler = async ({ request }) => {
	if (!getApplicationAdapterConfig().prPreviewsEnabled) {
		return json({ error: "PR previews are not enabled" }, { status: 404 });
	}
	if (!validateInternalToken(request)) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const action = body.action === "up" || body.action === "down" ? body.action : null;
	const prNumber = Number(body.prNumber);
	if (!action || !Number.isInteger(prNumber) || prNumber <= 0) {
		return json(
			{ error: "action ('up'|'down') and a positive integer prNumber are required" },
			{ status: 400 },
		);
	}
	const service = getApplicationAdapters().prPreviews;
	if (action === "down") {
		const result = await service.down({ prNumber });
		return json({ prNumber, ...result });
	}
	const headSha = typeof body.headSha === "string" ? body.headSha : "";
	if (!headSha) {
		return json({ error: "headSha is required for action 'up'" }, { status: 400 });
	}
	const status = service.up({
		prNumber,
		headSha,
		headRef: typeof body.headRef === "string" ? body.headRef : null,
		changedFiles: Array.isArray(body.changedFiles)
			? body.changedFiles.filter((f): f is string => typeof f === "string")
			: null,
		verify: typeof body.verify === "boolean" ? body.verify : undefined,
	});
	return json(status, { status: 202 });
};

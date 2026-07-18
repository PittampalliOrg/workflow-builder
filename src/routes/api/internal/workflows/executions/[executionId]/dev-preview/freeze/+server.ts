/**
 * POST /api/internal/workflows/executions/[executionId]/dev-preview/freeze
 *
 * Internal-only: freeze the live-sync source receivers of this execution's dev
 * previews WITHOUT tearing anything down (`dev/preview-freeze`). Used when a
 * preview environment is retained after its run: the adopted dev pods keep
 * serving, but their sources become immutable (`/__sync` is rejected after
 * freeze). Per-service outcomes; idempotent — already-frozen receivers report
 * `frozen`. Auth: requires PREVIEW_ACTION_INTERNAL_TOKEN, same as the sibling
 * dev/* action routes.
 */

import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { requirePreviewActionInternal } from "$lib/server/internal-auth";

type Body = {
	services?: unknown;
};

function requestedServices(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [
		...new Set(
			value.filter(
				(service): service is string =>
					typeof service === "string" && service.trim().length > 0,
			),
		),
	];
}

export const POST: RequestHandler = async ({ params, request }) => {
	requirePreviewActionInternal(request);
	const rawId = params.executionId;
	if (!rawId)
		return json({ ok: false, error: "executionId required" }, { status: 400 });
	const app = getApplicationAdapters();
	const workflowData = app.workflowData;
	// The orchestrator passes the Dapr instance id (`sw-<wf>-exec-<id>`); the
	// dev-preview session rows are keyed on the canonical execution id (same
	// normalization the ensure/teardown/snapshot routes do).
	const executionId = await workflowData.resolveCanonicalExecutionId({
		executionId: rawId,
	});

	let body: Body = {};
	try {
		body = (await request.json()) as Body;
	} catch {
		/* empty body is fine */
	}

	try {
		const result = await app.previewEnvironmentProvisioner.freezeSources({
			executionId,
			services: requestedServices(body.services),
		});
		if (result.services.length === 0) {
			return json({
				ok: false,
				skipped: "no_dev_previews",
				executionId,
				services: [],
			});
		}
		return json(result, { status: result.ok ? 200 : 502 });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error("[dev-preview] freeze failed:", message);
		return json({ ok: false, error: message }, { status: 503 });
	}
};

/**
 * POST /api/internal/workflows/executions/[executionId]/dev-preview/release
 *
 * Internal-only: release this execution's retained dev-preview adoption ON
 * DEMAND, outside any running workflow. Per Sandbox, the privileged
 * sandbox-execution-api DELETE `/internal/dev-preview/<name>` restores the
 * adopted prod Deployment from its stashed original-replicas annotation and
 * releases the adoption Lease. The retained preview environment itself stays
 * up; no source checkpoint is captured and the shared preview database is
 * preserved. Body: `{ service? }` narrows the release to one service;
 * otherwise ALL dev-preview Sandboxes for the execution are released.
 *
 * Auth: INTERNAL_API_TOKEN (sibling internal-route convention, for the
 * host->preview control path) or PREVIEW_ACTION_INTERNAL_TOKEN (the sibling
 * dev/* action credential). 404 when the execution has no dev previews.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import {
	validateInternalToken,
	validatePreviewActionInternalToken,
} from "$lib/server/internal-auth";

type Body = {
	service?: unknown;
};

export const POST: RequestHandler = async ({ params, request }) => {
	if (
		!validateInternalToken(request) &&
		!validatePreviewActionInternalToken(request)
	) {
		throw error(401, "invalid or missing internal token");
	}
	const rawId = params.executionId;
	if (!rawId)
		return json({ ok: false, error: "executionId required" }, { status: 400 });
	const app = getApplicationAdapters();
	const workflowData = app.workflowData;
	const executionId = await workflowData.resolveCanonicalExecutionId({
		executionId: rawId,
	});

	let body: Body = {};
	try {
		body = (await request.json()) as Body;
	} catch {
		/* empty body is fine */
	}
	const service =
		typeof body.service === "string" && body.service.trim().length > 0
			? body.service.trim()
			: null;

	try {
		const result = await app.previewEnvironmentProvisioner.releaseSandboxes({
			executionId,
			service,
		});
		if (!result.found) {
			return json(
				{
					ok: false,
					error: "no dev previews found for this execution",
					executionId,
					sandboxes: [],
				},
				{ status: 404 },
			);
		}
		return json(result, {
			status: !result.ok ? 503 : result.complete ? 200 : 202,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error("[dev-preview] release failed:", message);
		return json({ ok: false, error: message }, { status: 503 });
	}
};

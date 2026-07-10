/**
 * POST /api/internal/workflows/executions/[executionId]/dev-preview/snapshot
 *
 * Internal-only: capture a durable, promotable version of the code a
 * dev-pod-as-source run has produced SO FAR by pulling the dev pod's `/__export`
 * and storing it as a `source-bundle` (`tar-overlay` for one service,
 * `tar-overlay-set` atomically for many). A GAN fixture calls this once per loop
 * iteration so EVERY complete iteration is promotable. Best-effort — never fails
 * the run. Auth: requires PREVIEW_ACTION_INTERNAL_TOKEN.
 */

import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { requirePreviewActionInternal } from "$lib/server/internal-auth";

type Body = {
	nodeId?: string | null;
	iteration?: number | string | null;
	services?: unknown;
};

function expectedServices(value: unknown): string[] {
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
	// dev-preview session + execution rows are keyed on the canonical execution id
	// (same normalization the ensure/teardown routes do). Without this the capture
	// resolves no podIP and silently skips `no_dev_pod`.
	const executionId = await workflowData.resolveCanonicalExecutionId({
		executionId: rawId,
	});

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
	const services = expectedServices(body.services);
	if (services.length === 0) {
		return json({
			ok: false,
			skipped: "missing_expected_services",
			services: [],
		});
	}

	const result = await app.devPreviewSourceCapture.captureAcceptanceCandidate({
		executionId,
		nodeId: body.nodeId ?? "dev-preview",
		iteration: Number.isFinite(iteration as number)
			? (iteration as number)
			: null,
		expectedServices: services,
	});
	return json(result);
};

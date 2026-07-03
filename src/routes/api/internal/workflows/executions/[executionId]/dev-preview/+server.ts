import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { getApplicationAdapters } from "$lib/server/application";

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
	const rawId = params.executionId;
	if (!rawId) return json({ error: "executionId required" }, { status: 400 });
	const app = getApplicationAdapters();
	const workflowData = app.workflowData;
	// The orchestrator passes its dapr instance id; map to workflow_executions.id
	// so the persisted dev-preview row's FK holds + the Dev hub can find it.
	const executionId =
		await workflowData.resolveCanonicalExecutionId({
			executionId: rawId,
		});
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	try {
		const info = await app.previewEnvironmentProvisioner.provision({
			executionId,
			service: typeof body.service === "string" ? body.service : null,
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
			mode:
				body.mode === "preview-native" || body.mode === "host-throwaway"
					? body.mode
					: undefined,
			adopt: typeof body.adopt === "boolean" ? body.adopt : undefined,
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
	const rawId = params.executionId;
	if (!rawId) return json({ error: "executionId required" }, { status: 400 });
	const app = getApplicationAdapters();
	const workflowData = app.workflowData;
	const executionId =
		await workflowData.resolveCanonicalExecutionId({
			executionId: rawId,
		});
	const sandboxName = url.searchParams.get("sandboxName");
	const result = await app.previewEnvironmentProvisioner.teardown({
		executionId,
		sandboxName,
	});
	return json(result);
};

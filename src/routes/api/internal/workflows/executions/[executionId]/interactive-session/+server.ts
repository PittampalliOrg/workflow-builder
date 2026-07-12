import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { requireInternal } from "$lib/server/internal-auth";
import { spawnDevSession } from "$lib/server/sessions/dev-session-handoff";

/**
 * POST /api/internal/workflows/executions/[executionId]/interactive-session
 *
 * Workflow → interactive dev-session handoff (P3). Creates a persistent
 * interactive coding-agent session bound to the execution's shared /sandbox/work
 * and starts it (fire-and-forget relative to the session's lifetime, so the
 * parent workflow completes). Returns the session id + UI url.
 *
 * Internal-token auth. Body: { instructions, title?, persistent? }
 * `persistent` defaults true. Set `persistent:false` for the legacy bounded
 * workflow-host behavior.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	requireInternal(request);
	const rawId = params.executionId;
	if (!rawId) return json({ error: "executionId required" }, { status: 400 });
	// The orchestrator passes its dapr instance id; map to workflow_executions.id.
	const executionId =
		await getApplicationAdapters().workflowData.resolveCanonicalExecutionId({
			executionId: rawId,
		});
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const instructions =
		typeof body.instructions === "string" ? body.instructions : "";
	if (!instructions.trim()) {
		return json({ error: "instructions required" }, { status: 400 });
	}
	try {
		const result = await spawnDevSession({
			executionId,
			instructions,
			title: typeof body.title === "string" ? body.title : null,
			persistent: body.persistent !== false,
		});
		return json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error("[interactive-session] handoff failed:", message);
		return json({ error: message }, { status: 503 });
	}
};

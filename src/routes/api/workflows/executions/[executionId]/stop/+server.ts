import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	inspectDurableRun,
	stopDurableRun,
	type StopDurableRunMode,
} from "$lib/server/lifecycle";
import { isResourceInScope } from "$lib/server/workflows/project-scope";

const MODES = new Set<StopDurableRunMode>([
	"interrupt",
	"terminate",
	"purge",
	"reset",
]);

/**
 * POST /api/workflows/executions/[executionId]/stop
 *
 * The vetted way to stop a workflow execution and its per-session children.
 * Body: { mode, reason?, graceMs? }. Fail-closed: 409 if the durable tree did
 * not confirm closure (so the user/UI can retry rather than see a false
 * "cancelled").
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const mode: StopDurableRunMode =
		typeof body.mode === "string" && MODES.has(body.mode as StopDurableRunMode)
			? (body.mode as StopDurableRunMode)
			: "terminate";
	const reason = typeof body.reason === "string" ? body.reason : undefined;
	const graceMs = typeof body.graceMs === "number" ? body.graceMs : undefined;

	const target = { kind: "workflowExecution" as const, id: params.executionId };
	const inspected = await inspectDurableRun(target);
	if (inspected.notFound) return error(404, "Execution not found");
	if (inspected.scope && !isResourceInScope(inspected.scope, locals.session)) {
		return error(404, "Execution not found");
	}

	const result = await stopDurableRun(target, { mode, reason, graceMs });
	if (result.notFound) return error(404, "Execution not found");
	// confirmed → 200; stopping (requested + converging async) → 202; else 409.
	const status =
		result.state === "confirmed" ? 200 : result.state === "stopping" ? 202 : 409;
	return json({ ok: result.confirmed, ...result }, { status });
};

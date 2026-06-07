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
 * POST /api/v1/sessions/[id]/stop
 *
 * The vetted way to stop a session's durable run. Body: { mode, reason?, graceMs? }.
 * - interrupt: cooperative halt of the current turn (keeps the session).
 * - terminate: hard-stop the durable run.
 * - purge / reset: terminate + purge durable state + reap the Sandbox CR + flip DB terminal.
 * Fail-closed: returns 409 if the durable run did not confirm closure.
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

	const target = { kind: "session" as const, id: params.id };
	const inspected = await inspectDurableRun(target);
	if (inspected.notFound) return error(404, "Session not found");
	if (inspected.scope && !isResourceInScope(inspected.scope, locals.session)) {
		return error(404, "Session not found");
	}

	const result = await stopDurableRun(target, { mode, reason, graceMs });
	if (result.notFound) return error(404, "Session not found");
	return json({ ok: result.confirmed, ...result }, { status: result.confirmed ? 200 : 409 });
};

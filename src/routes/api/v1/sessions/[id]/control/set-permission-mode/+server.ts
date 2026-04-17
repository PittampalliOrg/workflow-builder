import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { raiseSessionEvent } from "$lib/server/sessions/control";

/**
 * Toggle the session's permission mode. `bypass` skips always_ask gates for
 * the remainder of the session (useful for trusted test flows); `default`
 * restores the agent's per-tool policy.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const mode = body.mode;
	if (mode !== "bypass" && mode !== "default") {
		return error(400, "mode must be 'bypass' or 'default'");
	}
	const result = await raiseSessionEvent(
		params.id,
		"session.control.set_permission_mode",
		{ mode },
	);
	if (!result.ok)
		return error(result.status, result.error ?? "set-permission-mode failed");
	return json({ mode });
};

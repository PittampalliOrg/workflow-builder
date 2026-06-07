import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { assertSessionInScope } from "$lib/server/sessions/scope";
import { raiseSessionAgentConfigPatch } from "$lib/server/sessions/agent-config-patch";

/**
 * Apply a validated agent-config patch to future turns in an active session.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	await assertSessionInScope(params.id, locals.session);
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const result = await raiseSessionAgentConfigPatch(params.id, body);
	if (!result.ok) {
		return error(result.status, result.error ?? "update-agent-config failed");
	}
	return json({ patch: result.patch, applies: "next_turn" });
};

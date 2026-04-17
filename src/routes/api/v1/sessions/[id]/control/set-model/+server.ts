import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { raiseSessionEvent } from "$lib/server/sessions/control";

/**
 * Change the model for subsequent turns. Raises
 * `session.control.set_model` on the workflow; the turn runner reads it
 * between turns and updates its LLM component reference.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const modelSpec =
		typeof body.modelSpec === "string" ? body.modelSpec.trim() : "";
	if (!modelSpec) return error(400, "modelSpec is required");
	const result = await raiseSessionEvent(
		params.id,
		"session.control.set_model",
		{ modelSpec },
	);
	if (!result.ok) return error(result.status, result.error ?? "set-model failed");
	return json({ modelSpec });
};

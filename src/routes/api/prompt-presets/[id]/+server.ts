import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	ApplicationPromptPresetValidationError,
} from "$lib/server/application/prompt-presets";
import { getApplicationAdapters } from "$lib/server/application";

export const PUT: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(400, "No active workspace");
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	try {
		const result = await getApplicationAdapters().promptPresets.update({
			id: params.id,
			projectId: locals.session.projectId,
			userId: locals.session.userId,
			body,
		});
		if (!result) return error(404, "Prompt preset not found");
		return json(result);
	} catch (err) {
		if (err instanceof ApplicationPromptPresetValidationError) return error(400, err.message);
		throw err;
	}
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(400, "No active workspace");
	const result = await getApplicationAdapters().promptPresets.archive({
		id: params.id,
		projectId: locals.session.projectId,
	});
	if (!result) return error(404, "Prompt preset not found");
	return json(result);
};

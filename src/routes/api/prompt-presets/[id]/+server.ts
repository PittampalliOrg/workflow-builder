import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	PromptPresetValidationError,
	archivePromptPreset,
	updatePromptPreset,
} from "$lib/server/prompt-presets";

export const PUT: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(400, "No active workspace");
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	try {
		const preset = await updatePromptPreset({
			id: params.id,
			projectId: locals.session.projectId,
			userId: locals.session.userId,
			body,
		});
		if (!preset) return error(404, "Prompt preset not found");
		return json({ preset });
	} catch (err) {
		if (err instanceof PromptPresetValidationError) return error(400, err.message);
		throw err;
	}
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(400, "No active workspace");
	const ok = await archivePromptPreset({
		id: params.id,
		projectId: locals.session.projectId,
	});
	if (!ok) return error(404, "Prompt preset not found");
	return json({ archived: true });
};

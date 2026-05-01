import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	PromptPresetValidationError,
	createPromptPreset,
	listPromptPresets,
} from "$lib/server/prompt-presets";

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(400, "No active workspace");
	const presets = await listPromptPresets({
		projectId: locals.session.projectId,
		includeDisabled: url.searchParams.get("includeDisabled") === "true",
	});
	return json({ presets });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(400, "No active workspace");
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	try {
		const preset = await createPromptPreset({
			projectId: locals.session.projectId,
			userId: locals.session.userId,
			body,
		});
		return json({ preset }, { status: 201 });
	} catch (err) {
		if (err instanceof PromptPresetValidationError) return error(400, err.message);
		throw err;
	}
};

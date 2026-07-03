import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	ApplicationPromptPresetValidationError,
} from "$lib/server/application/prompt-presets";
import { getApplicationAdapters } from "$lib/server/application";

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(400, "No active workspace");
	const result = await getApplicationAdapters().promptPresets.list({
		projectId: locals.session.projectId,
		includeDisabled: url.searchParams.get("includeDisabled") === "true",
	});
	return json(result);
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(400, "No active workspace");
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	try {
		const result = await getApplicationAdapters().promptPresets.create({
			projectId: locals.session.projectId,
			userId: locals.session.userId,
			body,
		});
		return json(result, { status: 201 });
	} catch (err) {
		if (err instanceof ApplicationPromptPresetValidationError) return error(400, err.message);
		throw err;
	}
};

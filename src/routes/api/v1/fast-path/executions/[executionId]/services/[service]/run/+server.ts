import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as { cmd?: string };
	const cmd = body.cmd?.trim();
	if (!cmd) return error(400, "cmd required");
	const result = await getApplicationAdapters().devPreviewSidecar.run({
		executionId: params.executionId,
		service: params.service,
		projectId: locals.session.projectId,
		cmd,
	});
	if (!result) return error(404, "Fast path service not found");
	return json(result);
};

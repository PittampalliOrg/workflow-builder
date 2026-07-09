import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

const MAX_SYNC_BYTES = 50 * 1024 * 1024;

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const archive = await request.arrayBuffer();
	if (archive.byteLength === 0) return error(400, "sync archive required");
	if (archive.byteLength > MAX_SYNC_BYTES) return error(413, "sync archive too large");
	const result = await getApplicationAdapters().devPreviewSidecar.sync({
		executionId: params.executionId,
		service: params.service,
		projectId: locals.session.projectId,
		archive,
		contentType: request.headers.get("content-type"),
	});
	if (!result) return error(404, "Fast path service not found");
	return json(result);
};

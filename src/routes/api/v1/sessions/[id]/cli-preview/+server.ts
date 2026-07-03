import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type { CliPreviewCommandResult } from "$lib/server/application/cli-preview";

/**
 * Start (or restart) a live preview server for an interactive-cli session and
 * return the in-app proxy URL. The server binds 0.0.0.0 in the session's cli
 * pod; reach it (over the BFF's tailnet hostname) at
 * `…/cli-preview/view/`.
 *
 * Body (all optional): { port?, cwd?, previewCommand? }.
 */
export const POST: RequestHandler = async ({ params, request, locals, url }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	return cliPreviewResponse(
		await getApplicationAdapters().cliPreview.startSessionPreview({
			sessionId: params.id!,
			projectId: locals.session.projectId ?? null,
			origin: url.origin,
			body: await request.json().catch(() => ({})),
		}),
	);
};

function cliPreviewResponse(result: CliPreviewCommandResult) {
	if (result.status === "error") return error(result.httpStatus, result.message);
	return json(result.body, { status: result.httpStatus ?? 200 });
}

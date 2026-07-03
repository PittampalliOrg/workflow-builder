import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type { CliPreviewCommandResult } from "$lib/server/application/cli-preview";

/**
 * Post-run live preview for an interactive-cli workflow RUN. Unlike the
 * session-scoped preview (which needs a live session pod), this provisions a
 * fresh credential-less pod that re-mounts the run's RETAINED shared JuiceFS
 * workspace — so a COMPLETED run can still be previewed. Idempotent: repeated
 * POSTs during cold-start adopt the same preview pod.
 *
 * Returns 202 `{ ready:false, provisioning:true }` while the pod boots — the
 * client should retry shortly. On success, returns the in-app proxy URL.
 *
 * Body (all optional): { port?, cwd?, previewCommand? }.
 */
export const POST: RequestHandler = async ({ params, request, locals, url }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	return cliPreviewResponse(
		await getApplicationAdapters().cliPreview.startExecutionPreview({
			executionId: params.executionId!,
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

import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type { SandboxPreviewCommandResult } from "$lib/server/application/sandbox-preview";
import { requirePreviewActionInternal } from "$lib/server/internal-auth";

/** Internal adapter used by browser/start-preview. */
export const POST: RequestHandler = async ({ params, request, url }) => {
	requirePreviewActionInternal(request);
	const body = await request.json().catch(() => ({}));
	return commandResponse(
		await getApplicationAdapters().sandboxPreview.startExecutionSandboxPreview({
			executionId: params.executionId,
			request,
			fallbackUrl: url,
			body,
		}),
	);
};

function commandResponse(result: SandboxPreviewCommandResult) {
	if (result.status === "ok") {
		return json(result.body, {
			status: result.httpStatus ?? 200,
			headers: { "cache-control": "no-store" },
		});
	}
	const message =
		typeof result.body === "string" ? result.body : result.body.message;
	return json(
		{ success: false, error: message },
		{
			status: result.httpStatus,
			headers: { "cache-control": "no-store" },
		},
	);
}

import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type { SandboxPreviewCommandResult } from "$lib/server/application/sandbox-preview";

export const POST: RequestHandler = async ({ params, request, url }) => {
	return sandboxPreviewResponse(
		await getApplicationAdapters().sandboxPreview.startExecutionSandboxPreview({
			executionId: params.executionId,
			request,
			fallbackUrl: url,
			body: await request.json().catch(() => ({})),
		}),
	);
};

export const DELETE: RequestHandler = async ({ params, url }) => {
	return sandboxPreviewResponse(
		await getApplicationAdapters().sandboxPreview.stopExecutionSandboxPreview({
			executionId: params.executionId,
			previewId: url.searchParams.get("previewId"),
		}),
	);
};

function sandboxPreviewResponse(result: SandboxPreviewCommandResult) {
	if (result.status === "error") return error(result.httpStatus, result.body);
	return json(result.body, { status: result.httpStatus ?? 200 });
}

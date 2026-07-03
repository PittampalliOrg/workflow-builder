import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type { SandboxPreviewProxyResult } from "$lib/server/application/sandbox-preview";

async function proxyRequest({
	request,
	params,
	url,
}: Parameters<RequestHandler>[0]): Promise<Response> {
	return sandboxPreviewProxyResponse(
		await getApplicationAdapters().sandboxPreview.proxyExecutionSandboxPreview({
			executionId: params.executionId,
			previewId: params.previewId,
			path: params.path,
			request,
			url,
		}),
	);
}

function sandboxPreviewProxyResponse(result: SandboxPreviewProxyResult): Response {
	if (result.status === "error") return error(result.httpStatus, result.body);
	return result.response;
}

export const GET: RequestHandler = proxyRequest;
export const HEAD: RequestHandler = proxyRequest;
export const POST: RequestHandler = proxyRequest;
export const PUT: RequestHandler = proxyRequest;
export const PATCH: RequestHandler = proxyRequest;
export const DELETE: RequestHandler = proxyRequest;

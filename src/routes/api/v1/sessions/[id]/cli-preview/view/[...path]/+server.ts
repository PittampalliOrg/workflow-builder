import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type { CliPreviewProxyResult } from "$lib/server/application/cli-preview";

/**
 * Reverse-proxy browser traffic to the live preview server running in an
 * interactive-cli session's pod (started via POST …/cli-preview). Reachable
 * over the BFF's tailnet hostname; root-relative asset URLs are rewritten to
 * stay under this proxy path.
 *
 * `?port=` overrides the upstream preview port (default 4321).
 */
async function handle({
	params,
	request,
	locals,
	url,
}: Parameters<RequestHandler>[0]): Promise<Response> {
	if (!locals.session?.userId) return error(401, "Authentication required");
	return cliPreviewProxyResponse(
		await getApplicationAdapters().cliPreview.proxySessionPreview({
			sessionId: params.id!,
			projectId: locals.session.projectId ?? null,
			request,
			url,
			path: params.path,
		}),
	);
}

function cliPreviewProxyResponse(result: CliPreviewProxyResult): Response {
	if (result.status === "error") return error(result.httpStatus, result.message);
	return result.response;
}

export const GET: RequestHandler = handle;
export const HEAD: RequestHandler = handle;
export const POST: RequestHandler = handle;
export const PUT: RequestHandler = handle;
export const PATCH: RequestHandler = handle;
export const DELETE: RequestHandler = handle;

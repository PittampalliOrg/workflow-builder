import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	CLI_PREVIEW_DEFAULT_PORT,
	proxyCliPreview,
	resolveExecutionCliPreviewTarget,
} from "$lib/server/sessions/cli-preview";

/**
 * Reverse-proxy browser traffic to the post-run preview server for a CLI
 * workflow run (provisioned via POST …/cli-preview). Reachable over the BFF's
 * tailnet hostname; root-relative asset URLs are rewritten to stay under this
 * proxy path. Does NOT provision on miss — a lapsed preview returns 502 so the
 * client re-runs Start (which re-provisions).
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
	const executionId = params.executionId!;
	const resolved = await resolveExecutionCliPreviewTarget(
		executionId,
		locals.session.projectId,
		{ provisionIfMissing: false },
	);
	if (!resolved.ok) {
		const status = "status" in resolved ? resolved.status : 502;
		return error(status, "message" in resolved ? resolved.message : "Preview unavailable");
	}

	const portParam = Number(url.searchParams.get("port"));
	const port =
		Number.isFinite(portParam) && portParam > 0 ? Math.trunc(portParam) : CLI_PREVIEW_DEFAULT_PORT;

	const proxyBasePath = `/api/workflows/executions/${encodeURIComponent(executionId)}/cli-preview/view`;
	const restPath = params.path ? `/${params.path}` : "/";
	const fwd = new URLSearchParams(url.searchParams);
	fwd.delete("port");
	const search = fwd.toString() ? `?${fwd.toString()}` : "";

	return proxyCliPreview(resolved.target.podIP, port, request, restPath, search, proxyBasePath);
}

export const GET: RequestHandler = handle;
export const HEAD: RequestHandler = handle;
export const POST: RequestHandler = handle;
export const PUT: RequestHandler = handle;
export const PATCH: RequestHandler = handle;
export const DELETE: RequestHandler = handle;

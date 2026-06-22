import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	CLI_PREVIEW_DEFAULT_PORT,
	proxyCliPreview,
	resolveCliPreviewTarget,
} from "$lib/server/sessions/cli-preview";

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
	const sessionId = params.id!;
	const resolved = await resolveCliPreviewTarget(sessionId, locals.session.projectId);
	if (!resolved.ok) return error(resolved.status, resolved.message);

	const portParam = Number(url.searchParams.get("port"));
	const port = Number.isFinite(portParam) && portParam > 0 ? Math.trunc(portParam) : CLI_PREVIEW_DEFAULT_PORT;

	const proxyBasePath = `/api/v1/sessions/${encodeURIComponent(sessionId)}/cli-preview/view`;
	const restPath = params.path ? `/${params.path}` : "/";
	// Drop our own `port` control param before forwarding.
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

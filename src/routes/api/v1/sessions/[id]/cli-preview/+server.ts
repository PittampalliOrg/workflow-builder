import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	CLI_PREVIEW_DEFAULT_PORT,
	resolveCliPreviewTarget,
	startCliPreview,
} from "$lib/server/sessions/cli-preview";

/**
 * Start (or restart) a live preview server for an interactive-cli session and
 * return the in-app proxy URL. The server binds 0.0.0.0 in the session's cli
 * pod; reach it (over the BFF's tailnet hostname) at
 * `…/cli-preview/view/`. See `$lib/server/sessions/cli-preview.ts`.
 *
 * Body (all optional): { port?, cwd?, previewCommand? }.
 */
export const POST: RequestHandler = async ({ params, request, locals, url }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const sessionId = params.id!;
	const resolved = await resolveCliPreviewTarget(sessionId, locals.session.projectId);
	if (!resolved.ok) return error(resolved.status, resolved.message);

	const body = (await request.json().catch(() => ({}))) as {
		port?: unknown;
		cwd?: unknown;
		previewCommand?: unknown;
	};
	const port =
		typeof body.port === "number" && Number.isFinite(body.port)
			? Math.trunc(body.port)
			: CLI_PREVIEW_DEFAULT_PORT;
	const cwd = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : "/sandbox/work/repo";
	const previewCommand = typeof body.previewCommand === "string" ? body.previewCommand : undefined;

	const result = await startCliPreview(resolved.target.podIP, { cwd, port, previewCommand });
	const base = `/api/v1/sessions/${encodeURIComponent(sessionId)}/cli-preview/view/`;
	return json({
		ready: result.ready,
		port,
		cwd,
		proxyUrl: `${url.origin}${base}`,
		log: result.log,
	});
};

import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	CLI_PREVIEW_DEFAULT_PORT,
	resolveExecutionCliPreviewTarget,
	startCliPreview,
} from "$lib/server/sessions/cli-preview";

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
	const executionId = params.executionId!;

	const resolved = await resolveExecutionCliPreviewTarget(
		executionId,
		locals.session.projectId,
	);
	if (!resolved.ok) {
		if ("provisioning" in resolved && resolved.provisioning) {
			return json({ ready: false, provisioning: true, message: resolved.message }, { status: 202 });
		}
		return error(resolved.status, resolved.message);
	}

	const body = (await request.json().catch(() => ({}))) as {
		port?: unknown;
		cwd?: unknown;
		previewCommand?: unknown;
	};
	const port =
		typeof body.port === "number" && Number.isFinite(body.port)
			? Math.trunc(body.port)
			: CLI_PREVIEW_DEFAULT_PORT;
	const cwd =
		typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : "/sandbox/work/repo";
	const previewCommand =
		typeof body.previewCommand === "string" ? body.previewCommand : undefined;

	const result = await startCliPreview(resolved.target.podIP, { cwd, port, previewCommand });
	const base = `/api/workflows/executions/${encodeURIComponent(executionId)}/cli-preview/view/`;
	return json({
		ready: result.ready,
		port,
		cwd,
		reused: resolved.target.reused,
		sharedWorkspaceKey: resolved.target.sharedWorkspaceKey,
		proxyUrl: `${url.origin}${base}`,
		log: result.log,
	});
};

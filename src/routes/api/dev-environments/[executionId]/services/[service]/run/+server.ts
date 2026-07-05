import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * POST /api/dev-environments/[executionId]/services/[service]/run
 * Body: { cmd: string }
 *
 * B5: run one allowlisted named command (registry deps/testCommands) on a
 * service's dev pod via the dev-sync-sidecar `/__run`. The command is validated
 * against the registry allowlist inside the sidecar port BEFORE the request
 * leaves the host; the sidecar's own DEV_SYNC_COMMANDS_JSON allowlist is the
 * second gate.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as { cmd?: string };
	const cmd = body.cmd?.trim();
	if (!cmd) return error(400, "cmd required");

	const result = await getApplicationAdapters().devPreviewSidecar.run({
		executionId: params.executionId,
		service: params.service,
		projectId: locals.session.projectId,
		cmd,
	});
	if (!result) return error(404, "Dev environment service not found");
	return json(result);
};

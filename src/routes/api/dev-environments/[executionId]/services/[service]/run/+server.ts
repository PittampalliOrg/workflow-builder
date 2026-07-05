import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { runSidecarCommand } from "$lib/server/workflows/dev-preview-sidecar";

/**
 * POST /api/dev-environments/[executionId]/services/[service]/run
 * Body: { cmd: string }
 *
 * B5: run one allowlisted named command (registry deps/testCommands) on a
 * service's dev pod via the dev-sync-sidecar `/__run`. The BFF validates the
 * name against the registry BEFORE the request leaves the host; the sidecar's
 * own DEV_SYNC_COMMANDS_JSON allowlist is the second gate.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as { cmd?: string };
	const cmd = body.cmd?.trim();
	if (!cmd) return error(400, "cmd required");

	const environments = await getApplicationAdapters().workflowData.listDevEnvironments({
		projectId: locals.session.projectId,
	});
	const environment = environments.find(
		(e) => e.executionId === params.executionId && e.service === params.service,
	);
	if (!environment) return error(404, "Dev environment service not found");

	const result = await runSidecarCommand({
		syncUrl: environment.syncUrl,
		service: environment.service,
		cmd,
	});
	return json({ service: environment.service, cmd, result });
};

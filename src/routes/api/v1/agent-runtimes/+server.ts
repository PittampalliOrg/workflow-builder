import type { RequestHandler } from "./$types";
import { error, json } from "@sveltejs/kit";

import { getApplicationAdapters } from "$lib/server/application";

/**
 * Workspace-scoped list of SandboxWarmPools (the Arc 3 replacement for the
 * AgentRuntime CR list), filtered to agents in the caller's active workspace.
 * After Arc 3, only browser/Playwright agents have a per-agent warm pool —
 * non-browser agents now use per-session Sandboxes from sandbox-execution-api
 * and don't appear in this list.
 *
 * Powers the /admin/agent-runtimes dashboard.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const service = getApplicationAdapters().agentRuntimeControl;
	return json(
		await service.listRuntimes({
			projectId: locals.session.projectId ?? null,
		}),
	);
};

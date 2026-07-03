import type { RequestHandler } from "./$types";
import { error, json } from "@sveltejs/kit";

import { getApplicationAdapters } from "$lib/server/application";

/**
 * Workspace-scoped read-through of an agent's SandboxWarmPool status. After
 * Arc 3, browser/Playwright agents have a SandboxWarmPool emitted by
 * registry-sync; non-browser agents have no per-agent K8s state and return
 * `exists: false`.
 *
 * Powers the AgentRuntimeCard component on the agent detail page. The shape
 * is intentionally thin (phase, replica counts, browserSidecarEnabled flag,
 * live container readiness) — same fields the UI consumed pre-Arc-3.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");

	const slug = params.slug!;
	const result = await getApplicationAdapters().agentRuntimeControl.getRuntimeDetail({
		slug,
		projectId: locals.session.projectId ?? null,
	});
	if (result.status === "not_found") return error(404, result.message);
	return json(result.body);
};

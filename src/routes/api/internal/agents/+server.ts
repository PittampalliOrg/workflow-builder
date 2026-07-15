import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * POST /api/internal/agents
 *
 * Internal (X-Internal-Token) agent-creation endpoint. The public
 * `POST /api/agents` route requires a browser session; this one lets trusted
 * in-cluster callers — notably the workflow-mcp-server `create_agent` tool —
 * register an agent on behalf of a resolved owner. The caller is responsible
 * for resolving `userId` (and optionally `projectId`) from its own auth context
 * BEFORE calling; this route does not derive ownership from ambient state, so a
 * caller can never create an agent without naming the owner.
 *
 * Body: { userId: string, projectId?: string | null, agent: <createAgent body> }
 * where the `agent` object matches the public create body:
 *   { name, slug?, description?, avatar?, tags?, runtime?, config? }.
 */
export const POST: RequestHandler = async ({ request }) => {
	requireInternal(request);

	let payload: {
		userId?: unknown;
		projectId?: unknown;
		agent?: unknown;
	};
	try {
		payload = (await request.json()) as typeof payload;
	} catch {
		return error(400, "invalid JSON body");
	}

	const userId =
		typeof payload.userId === "string" ? payload.userId.trim() : "";
	if (!userId) return error(400, "userId is required");

	const agentBody =
		payload.agent && typeof payload.agent === "object"
			? (payload.agent as Record<string, unknown>)
			: {};
	if (typeof agentBody.name !== "string" || !agentBody.name.trim()) {
		return error(400, "agent.name is required");
	}

	const projectId =
		typeof payload.projectId === "string" ? payload.projectId : null;

	const { agentCatalog } = getApplicationAdapters();
	const result = await agentCatalog.createAgent({
		userId,
		currentProjectId: projectId,
		templateSlug: null,
		body: agentBody,
	});
	if (result.status === "invalid") return error(400, result.message);
	return json({ agent: result.agent }, { status: 201 });
};

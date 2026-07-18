import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { getApplicationAdapters } from "$lib/server/application";
import { resolveInternalWorkflowPrincipal } from "../workflow-mcp-principal";

/**
 * POST /api/internal/agents
 *
 * Internal (X-Internal-Token) agent-creation endpoint. The public
 * `POST /api/agents` route requires a browser session; this one lets trusted
 * in-cluster callers — notably the workflow-mcp-server `create_agent` tool —
 * register an agent on behalf of a BFF-signed workspace principal. Body owner
 * fields are retained for compatibility but may not override the assertion.
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

  const app = getApplicationAdapters();
  const principalResult = await resolveInternalWorkflowPrincipal(
    request,
    app.internalWorkflowPrincipal,
    { requiredScope: "agent:write" },
  );
  if (!principalResult.ok) {
    return error(principalResult.status, principalResult.error);
  }
  const { userId, projectId } = principalResult.principal;
  if (
    (typeof payload.userId === "string" && payload.userId.trim() !== userId) ||
    (typeof payload.projectId === "string" && payload.projectId !== projectId)
  ) {
    return error(403, "agent owner does not match the authenticated principal");
  }

  const submittedAgentBody =
		payload.agent && typeof payload.agent === "object"
			? (payload.agent as Record<string, unknown>)
			: {};
  const agentBody: Record<string, unknown> = {
    ...submittedAgentBody,
    projectId,
  };
	if (typeof agentBody.name !== "string" || !agentBody.name.trim()) {
		return error(400, "agent.name is required");
	}

  const result = await app.agentCatalog.createAgent({
		userId,
		currentProjectId: projectId,
		templateSlug: null,
		body: agentBody,
	});
	if (result.status === "invalid") return error(400, result.message);
	return json({ agent: result.agent }, { status: 201 });
};

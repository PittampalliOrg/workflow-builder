import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { requireInternal } from "$lib/server/internal-auth";

/** Resolve a Workflow MCP credential into its authoritative BFF principal. */
export const POST: RequestHandler = async ({ request }) => {
  requireInternal(request);

  const result = await getApplicationAdapters().workflowMcpPrincipal.resolve({
    authorizationHeader: request.headers.get("authorization"),
    platformToken: request.headers.get("x-wfb-session-token")?.trim() ?? "",
    requestedSessionId: request.headers.get("x-wfb-session-id")?.trim() ?? "",
  });

  if (!result.ok) {
    return json(
      { authenticated: false, code: result.code, error: result.error },
      { status: result.status },
    );
  }

  return json({ authenticated: true, ...result.principal });
};

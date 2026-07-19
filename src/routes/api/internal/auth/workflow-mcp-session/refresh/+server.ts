import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { validateInternalToken } from "$lib/server/internal-auth";

export const POST: RequestHandler = async ({ request }) => {
  if (!validateInternalToken(request)) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  const sessionId = request.headers.get("x-wfb-session-id")?.trim() ?? "";
  const platformToken =
    request.headers.get("x-wfb-session-token")?.trim() ?? "";
  if (!sessionId || !platformToken) {
    return json(
      { error: "A session ID and signed platform credential are required" },
      { status: 400 },
    );
  }

  const result =
    await getApplicationAdapters().workflowMcpPrincipal.refreshPlatformSession({
      platformToken,
      requestedSessionId: sessionId,
    });
  if (!result.ok) {
    return json(
      { code: result.code, error: result.error },
      { status: result.status },
    );
  }
  return json({
    sessionId,
    workflowMcpSessionToken: result.sessionToken,
  });
};

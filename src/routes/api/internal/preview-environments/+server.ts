import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { safePreviewName } from "$lib/types/dev-previews";
import { guardPreviewMcp, previewMcpError } from "./guard";

function routeError(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, { status });
}

/** Platform-admin fleet discovery for Workflow MCP. */
export const GET: RequestHandler = async ({ request }) => {
  const guard = await guardPreviewMcp(request, {
    requiredScope: "workflow:read",
    admin: true,
    controlPlane: true,
  });
  if (!guard.ok) return guard.response;
  try {
    return json(await guard.app.vclusterPreviews.list(), {
      headers: { "cache-control": "no-store" },
    });
  } catch (cause) {
    return previewMcpError(cause);
  }
};

/** Launch only the server-authorized app-live cold lane. */
export const POST: RequestHandler = async ({ request }) => {
  const guard = await guardPreviewMcp(request, {
    requiredScope: "workflow:execute",
    admin: true,
    controlPlane: true,
  });
  if (!guard.ok) return guard.response;

  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body) return routeError(400, "preview_invalid_json", "Invalid JSON body");
  const rawName = typeof body.name === "string" ? body.name : "";
  const name = safePreviewName(rawName);
  if (!name || name === "preview") {
    return routeError(400, "preview_name_required", "A preview name is required");
  }

  try {
    const outcome = await guard.app.previewEnvironmentLaunchBroker.launchForUser({
      name,
      userId: guard.principal.userId,
      profile: "app-live",
      ...(Array.isArray(body.services)
        ? { services: body.services as string[] }
        : {}),
      ...(typeof body.sourceRef === "string"
        ? { sourceRef: body.sourceRef }
        : {}),
      ...(typeof body.ttlHours === "number"
        ? { ttlHours: body.ttlHours }
        : {}),
      ...(body.lifecycle === "ephemeral" || body.lifecycle === "retained"
        ? { lifecycle: body.lifecycle }
        : {}),
    });
    const result = guard.app.vclusterPreviews.presentLaunch(outcome);
    if (!result.ok) {
      return routeError(
        result.reason === "capacity" ? 429 : 409,
        `preview_${result.reason}`,
        result.message,
      );
    }
    return json(
      { preview: result.preview, pooled: result.pooled },
      { status: 202, headers: { "retry-after": "5" } },
    );
  } catch (cause) {
    return previewMcpError(cause);
  }
};

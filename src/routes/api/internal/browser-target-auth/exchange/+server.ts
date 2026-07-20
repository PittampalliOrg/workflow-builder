import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { validateInternalToken } from "$lib/server/internal-auth";

/**
 * Internal bridge-only exchange. A purpose assertion alone is not a user
 * credential: callers must also present the platform INTERNAL_API_TOKEN, and
 * the application service revalidates authoritative execution ownership.
 */
export const POST: RequestHandler = async ({ request }) => {
  if (!validateInternalToken(request)) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const assertion =
    typeof body?.targetAuthAssertion === "string"
      ? body.targetAuthAssertion.trim()
      : "";
  const executionId =
    typeof body?.executionId === "string" ? body.executionId.trim() : "";
  if (!assertion || !executionId) {
    return json(
      { error: "targetAuthAssertion and executionId are required" },
      { status: 400 },
    );
  }

  const exchange = await getApplicationAdapters().workflowTargetAuth.exchange({
    assertion,
    executionId,
  });
  if (!exchange) {
    return json(
      { error: "Invalid browser target authorization" },
      { status: 403 },
    );
  }
  return json(exchange, {
    headers: {
      "Cache-Control": "no-store",
      Pragma: "no-cache",
    },
  });
};

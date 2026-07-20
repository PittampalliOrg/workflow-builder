import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { validateInternalToken } from "$lib/server/internal-auth";

/** Revalidate a browser capability without issuing or returning a credential. */
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

  const validation = await getApplicationAdapters().workflowTargetAuth.validate(
    {
      assertion,
      executionId,
    },
  );
  if (!validation) {
    return json(
      { error: "Invalid browser target authorization" },
      { status: 403 },
    );
  }
  return json(validation, {
    headers: {
      "Cache-Control": "no-store",
      Pragma: "no-cache",
    },
  });
};

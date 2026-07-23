import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { requirePreviewActionInternal } from "$lib/server/internal-auth";

const ALLOWED_BODY_FIELDS = new Set(["evidence"]);
const ALLOWED_EVIDENCE_FIELDS = new Set(["storageRef", "width", "height"]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Resolve model-reported browser evidence through the execution-owned store. */
export const POST: RequestHandler = async ({ params, request }) => {
  requirePreviewActionInternal(request);
  if (!params.executionId) {
    return json({ ok: false, error: "executionId required" }, { status: 400 });
  }
  const body = record(await request.json().catch(() => null));
  if (
    !body ||
    Object.keys(body).some((key) => !ALLOWED_BODY_FIELDS.has(key)) ||
    !Array.isArray(body.evidence) ||
    body.evidence.some((value) => {
      const item = record(value);
      return (
        !item ||
        Object.keys(item).some((key) => !ALLOWED_EVIDENCE_FIELDS.has(key)) ||
        typeof item.storageRef !== "string" ||
        typeof item.width !== "number" ||
        typeof item.height !== "number"
      );
    })
  ) {
    return json(
      { ok: false, error: "body must contain only screenshot evidence claims" },
      { status: 400 },
    );
  }

  const app = getApplicationAdapters();
  const executionId = await app.workflowData.resolveCanonicalExecutionId({
    executionId: params.executionId,
  });
  const result = await app.workflowBrowserEvidence.verify({
    executionId,
    evidence: body.evidence as Array<{
      storageRef: string;
      width: number;
      height: number;
    }>,
  });
  if (result.status === "error") {
    return json(
      { ok: false, executionId, error: result.message },
      { status: result.httpStatus },
    );
  }
  return json(result.body);
};

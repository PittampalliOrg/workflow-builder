import { env } from "$env/dynamic/private";
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { PreviewInfrastructureCandidateBrokerError } from "$lib/server/application/preview-infrastructure-candidate-broker";
import { requirePreviewControlBroker } from "$lib/server/internal-auth";
import {
  BoundedJsonBodyError,
  PREVIEW_CONTROL_JSON_MAX_BYTES,
  readBoundedJsonObject,
} from "../../_shared/bounded-json-body";

const ALLOWED_FIELDS = new Set([
  "requestId",
  "name",
  "userId",
  "pullRequestNumber",
  "ttlHours",
  "lifecycle",
]);

export const POST: RequestHandler = async ({ request }) => {
  if (env.PREVIEW_CONTROL_BROKER_MODE?.trim().toLowerCase() !== "true") {
    return json({ ok: false, error: "not found" }, { status: 404 });
  }
  requirePreviewControlBroker(request);
  let body: Record<string, unknown>;
  try {
    body = await readBoundedJsonObject(request, PREVIEW_CONTROL_JSON_MAX_BYTES);
  } catch (cause) {
    if (cause instanceof BoundedJsonBodyError) {
      return json(
        { ok: false, error: cause.message },
        { status: cause.statusCode },
      );
    }
    throw cause;
  }
  const unexpected = Object.keys(body).filter(
    (key) => !ALLOWED_FIELDS.has(key),
  );
  if (unexpected.length > 0) {
    return json(
      {
        ok: false,
        error: `unsupported broker fields: ${unexpected.sort().join(", ")}`,
      },
      { status: 400 },
    );
  }
  try {
    const result =
      await getApplicationAdapters().previewInfrastructureCandidates.launch(
        body as never,
      );
    return json(result, { status: result.ok ? 202 : 409 });
  } catch (cause) {
    if (cause instanceof PreviewInfrastructureCandidateBrokerError) {
      return json(
        { ok: false, error: cause.message },
        { status: cause.statusCode },
      );
    }
    throw cause;
  }
};

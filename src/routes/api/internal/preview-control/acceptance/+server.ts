import { env } from "$env/dynamic/private";
import { json, type RequestHandler } from "@sveltejs/kit";
import { getApplicationAdapters } from "$lib/server/application";
import { PreviewAcceptanceBrokerInputError } from "$lib/server/application/preview-acceptance-broker";
import { PreviewControlSourceAuthorityError } from "$lib/server/application/preview-control-source-authority";
import { validatePreviewControlIdentity } from "$lib/server/application/preview-control-identity";
import { requirePreviewControlCapability } from "$lib/server/internal-auth";
import {
  BoundedJsonBodyError,
  PREVIEW_CONTROL_JSON_MAX_BYTES,
  readBoundedJsonObject,
} from "../../_shared/bounded-json-body";

const ALLOWED_FIELDS = new Set([
  "requestId",
  "previewName",
  "pullRequest",
  "environmentRequestId",
  "environmentPlatformRevision",
  "environmentSourceRevision",
  "catalogDigest",
]);

export const POST: RequestHandler = async ({ request }) => {
  if (env.PREVIEW_CONTROL_BROKER_MODE?.trim().toLowerCase() !== "true") {
    return json({ ok: false, error: "not found" }, { status: 404 });
  }
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
  let identity;
  try {
    const value = body;
    identity = validatePreviewControlIdentity({
      previewName: String(value.previewName ?? ""),
      environmentRequestId: String(value.environmentRequestId ?? ""),
      environmentPlatformRevision: String(
        value.environmentPlatformRevision ?? "",
      ),
      environmentSourceRevision: String(value.environmentSourceRevision ?? ""),
      catalogDigest: String(value.catalogDigest ?? "") as `sha256:${string}`,
    });
  } catch {
    return json(
      { ok: false, error: "invalid preview capability identity" },
      { status: 400 },
    );
  }
  requirePreviewControlCapability(request, identity);
  try {
    const result =
      await getApplicationAdapters().previewAcceptanceBroker.replay(
        body as never,
      );
    return json(result, { status: result.ok ? 200 : 422 });
  } catch (cause) {
    if (cause instanceof PreviewAcceptanceBrokerInputError) {
      return json({ ok: false, error: cause.message }, { status: 409 });
    }
    if (cause instanceof PreviewControlSourceAuthorityError) {
      return json(
        { ok: false, error: cause.message, code: cause.code },
        { status: cause.code === "owner-not-admin" ? 403 : 409 },
      );
    }
    throw cause;
  }
};

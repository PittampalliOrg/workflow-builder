import { env } from "$env/dynamic/private";
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { PreviewControlSourceAuthorityError } from "$lib/server/application/preview-control-source-authority";
import { PreviewDevelopmentBrokerInputError } from "$lib/server/application/preview-development-build-broker";
import { validatePreviewControlIdentity } from "$lib/server/application/preview-control-identity";
import { requirePreviewControlCapability } from "$lib/server/internal-auth";
import {
  BoundedJsonBodyError,
  PREVIEW_CONTROL_JSON_MAX_BYTES,
  readBoundedJsonObject,
} from "../../_shared/bounded-json-body";

const ALLOWED_FIELDS = new Set([
  "requestId",
  "executionId",
  "artifactId",
  "previewName",
  "catalogDigest",
  "services",
  "artifactIdentity",
  "environmentRequestId",
  "environmentPlatformRevision",
  "environmentSourceRevision",
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
      await getApplicationAdapters().previewDevelopmentBuildBroker.build(
        body as never,
      );
    return json(result, { status: result.ok ? 200 : 207 });
  } catch (cause) {
    if (cause instanceof PreviewDevelopmentBrokerInputError) {
      return json(
        { ok: false, error: cause.message, stage: cause.stage },
        { status: cause.statusCode },
      );
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

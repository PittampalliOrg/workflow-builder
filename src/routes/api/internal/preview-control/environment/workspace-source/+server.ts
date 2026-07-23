import { env } from "$env/dynamic/private";
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { PreviewControlSourceAuthorityError } from "$lib/server/application/preview-control-source-authority";
import { PreviewWorkspaceGatewayError } from "$lib/server/application/ports";
import { validatePreviewControlIdentity } from "$lib/server/application/preview-control-identity";
import { requirePreviewControlCapability } from "$lib/server/internal-auth";
import {
  BoundedJsonBodyError,
  PREVIEW_CONTROL_JSON_MAX_BYTES,
  readBoundedJsonObject,
} from "../../../_shared/bounded-json-body";

const ALLOWED_FIELDS = new Set([
  "previewName",
  "environmentRequestId",
  "environmentPlatformRevision",
  "environmentSourceRevision",
  "catalogDigest",
  "service",
]);
const SAFE_SERVICE = /^[a-z0-9][a-z0-9-]{0,62}$/;

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
  const service = typeof body.service === "string" ? body.service.trim() : "";
  try {
    identity = validatePreviewControlIdentity({
      previewName: String(body.previewName ?? ""),
      environmentRequestId: String(body.environmentRequestId ?? ""),
      environmentPlatformRevision: String(
        body.environmentPlatformRevision ?? "",
      ),
      environmentSourceRevision: String(body.environmentSourceRevision ?? ""),
      catalogDigest: String(body.catalogDigest ?? "") as `sha256:${string}`,
    });
    if (!SAFE_SERVICE.test(service)) throw new Error("invalid service");
  } catch {
    return json(
      { ok: false, error: "invalid preview workspace source identity" },
      { status: 400 },
    );
  }
  requirePreviewControlCapability(request, identity);
  try {
    const result =
      await getApplicationAdapters().previewWorkspaceSourceBroker.fetchExact({
        identity,
        service,
      });
    return new Response(Buffer.from(result.bundle), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.git.bundle",
        "Content-Length": String(result.bundle.byteLength),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Wfb-Preview-Source-Sha256": result.bundleSha256,
        "X-Wfb-Preview-Source-File-Count": String(result.fileCount),
        "X-Wfb-Preview-Source-Repository": result.repository,
        "X-Wfb-Preview-Source-Revision": result.sourceRevision,
      },
    });
  } catch (cause) {
    if (cause instanceof PreviewWorkspaceGatewayError) {
      return json(
        { ok: false, error: cause.message, code: cause.code },
        { status: cause.status },
      );
    }
    if (cause instanceof PreviewControlSourceAuthorityError) {
      const status =
        cause.code === "owner-not-admin"
          ? 403
          : cause.code === "not-found"
            ? 404
            : cause.code === "not-ready"
              ? 503
              : 409;
      return json(
        { ok: false, error: cause.message, code: cause.code },
        { status },
      );
    }
    throw cause;
  }
};

import { env } from "$env/dynamic/private";
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { PreviewControlSourceAuthorityError } from "$lib/server/application/preview-control-source-authority";
import { PreviewDevSyncCredentialInputError } from "$lib/server/application/preview-dev-sync-credentials";
import { validatePreviewControlIdentity } from "$lib/server/application/preview-control-identity";
import { requirePreviewDevSyncMintCapability } from "$lib/server/internal-auth";
import {
  BoundedJsonBodyError,
  PREVIEW_CONTROL_JSON_MAX_BYTES,
  readBoundedJsonObject,
} from "../../_shared/bounded-json-body";

const ALLOWED_FIELDS = new Set([
  "previewName",
  "environmentRequestId",
  "environmentPlatformRevision",
  "environmentSourceRevision",
  "catalogDigest",
  "executionId",
  "service",
]);

export const POST: RequestHandler = async ({ request }) => {
  if (
    (
      env.PREVIEW_CONTROL_BROKER_MODE ??
      process.env.PREVIEW_CONTROL_BROKER_MODE ??
      ""
    )
      .trim()
      .toLowerCase() !== "true"
  ) {
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
        error: `unsupported mint fields: ${unexpected.sort().join(", ")}`,
      },
      { status: 400 },
    );
  }
  let identity;
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
  } catch {
    return json(
      { ok: false, error: "invalid preview mint identity" },
      { status: 400 },
    );
  }
  requirePreviewDevSyncMintCapability(request, identity);
  try {
    const credentials =
      await getApplicationAdapters().previewDevSyncCredentialMint.mint({
        ...identity,
        executionId: String(body.executionId ?? ""),
        service: String(body.service ?? ""),
      });
    return json(credentials);
  } catch (cause) {
    if (cause instanceof PreviewDevSyncCredentialInputError) {
      return json({ ok: false, error: cause.message }, { status: 400 });
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

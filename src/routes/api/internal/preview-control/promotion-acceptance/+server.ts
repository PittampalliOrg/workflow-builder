import { env } from "$env/dynamic/private";
import { json, type RequestHandler } from "@sveltejs/kit";
import { getApplicationAdapters } from "$lib/server/application";
import type { PreviewSourcePromotionAcceptanceRequest } from "$lib/server/application/ports";
import { PreviewAcceptanceBrokerInputError } from "$lib/server/application/preview-acceptance-broker";
import { PreviewControlSourceAuthorityError } from "$lib/server/application/preview-control-source-authority";
import { PreviewSourcePromotionAcceptanceError } from "$lib/server/application/preview-source-promotion-acceptance";
import { validatePreviewControlIdentity } from "$lib/server/application/preview-control-identity";
import { requirePreviewControlCapability } from "$lib/server/internal-auth";
import {
  BoundedJsonBodyError,
  PREVIEW_CONTROL_JSON_MAX_BYTES,
  readBoundedJsonObject,
} from "../../_shared/bounded-json-body";

const ALLOWED = new Set([
  "requestId",
  "previewName",
  "environmentRequestId",
  "environmentPlatformRevision",
  "environmentSourceRevision",
  "catalogDigest",
  "executionId",
  "receiptId",
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
      return json({ ok: false, error: cause.message }, { status: cause.statusCode });
    }
    throw cause;
  }
  const unexpected = Object.keys(body).filter((key) => !ALLOWED.has(key));
  if (unexpected.length > 0) {
    return json(
      { ok: false, error: `unsupported acceptance fields: ${unexpected.sort().join(", ")}` },
      { status: 400 },
    );
  }
  let command: PreviewSourcePromotionAcceptanceRequest;
  let identity;
  try {
    identity = validatePreviewControlIdentity({
      previewName: required(body.previewName),
      environmentRequestId: required(body.environmentRequestId),
      environmentPlatformRevision: required(body.environmentPlatformRevision),
      environmentSourceRevision: required(body.environmentSourceRevision),
      catalogDigest: required(body.catalogDigest) as `sha256:${string}`,
    });
    command = {
      requestId: required(body.requestId),
      ...identity,
      executionId: required(body.executionId),
      receiptId: required(body.receiptId),
    };
  } catch (cause) {
    return json({ ok: false, error: "promotion acceptance identity is invalid" }, { status: 400 });
  }
  requirePreviewControlCapability(request, identity);
  try {
    const result = await getApplicationAdapters().previewSourcePromotionAcceptance.replay(command);
    return receiptJson(command.receiptId, result, result.ok ? 200 : 422);
  } catch (cause) {
    if (cause instanceof PreviewSourcePromotionAcceptanceError) {
      return receiptJson(
        command.receiptId,
        { ok: false, error: cause.message },
        cause.statusCode,
      );
    }
    if (cause instanceof PreviewAcceptanceBrokerInputError) {
      return receiptJson(
        command.receiptId,
        { ok: false, error: cause.message },
        409,
      );
    }
    if (cause instanceof PreviewControlSourceAuthorityError) {
      return receiptJson(
        command.receiptId,
        { ok: false, error: cause.message, code: cause.code },
        cause.code === "owner-not-admin" ? 403 : 409,
      );
    }
    throw cause;
  }
};

function required(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("required");
  return value.trim();
}

const RECEIPT_ID = /^pspr_[0-9a-f]{64}$/;

function receiptJson(
  receiptId: string,
  body: unknown,
  status: number,
): Response {
  return json(body, {
    status,
    ...(RECEIPT_ID.test(receiptId)
      ? { headers: { "X-Preview-Promotion-Receipt": receiptId } }
      : {}),
  });
}

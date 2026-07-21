import { env } from "$env/dynamic/private";
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { validatePreviewControlIdentity } from "$lib/server/application/preview-control-identity";
import { PreviewControlSourceAuthorityError } from "$lib/server/application/preview-control-source-authority";
import {
  PreviewTraceQueryError,
  PreviewTraceQueryUnavailableError,
} from "$lib/server/application/preview-traces";
import {
  PreviewTraceQueryTimeoutError,
  type PreviewControlIdentity,
} from "$lib/server/application/ports";
import {
  requirePreviewControlCapability,
  validatePreviewControlBrokerToken,
} from "$lib/server/internal-auth";
import {
  BoundedJsonBodyError,
  readBoundedJsonObject,
} from "../../../_shared/bounded-json-body";

const MAX_QUERY_BYTES = 16 * 1024;
const IDENTITY_KEYS = [
  "previewName",
  "environmentRequestId",
  "environmentPlatformRevision",
  "environmentSourceRevision",
  "catalogDigest",
] as const;

function parseIdentity(value: unknown): PreviewControlIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PreviewTraceQueryError(
      "invalid-request",
      "preview trace identity is invalid",
    );
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== IDENTITY_KEYS.length ||
    Object.keys(input).some(
      (key) => !(IDENTITY_KEYS as readonly string[]).includes(key),
    ) ||
    IDENTITY_KEYS.some((key) => typeof input[key] !== "string")
  ) {
    throw new PreviewTraceQueryError(
      "invalid-request",
      "preview trace identity is invalid",
    );
  }
  try {
    return validatePreviewControlIdentity(
      input as unknown as PreviewControlIdentity,
    );
  } catch {
    throw new PreviewTraceQueryError(
      "invalid-request",
      "preview trace identity is invalid",
    );
  }
}

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
    body = await readBoundedJsonObject(request, MAX_QUERY_BYTES);
  } catch (cause) {
    if (cause instanceof BoundedJsonBodyError) {
      return json(
        { ok: false, error: cause.message },
        { status: cause.statusCode },
      );
    }
    throw cause;
  }
  if (
    Object.keys(body).length !== 2 ||
    !Object.keys(body).every((key) => key === "identity" || key === "query")
  ) {
    return json(
      { ok: false, error: "invalid preview trace command" },
      { status: 400 },
    );
  }

  try {
    const identity = parseIdentity(body.identity);
    if (!validatePreviewControlBrokerToken(request)) {
      requirePreviewControlCapability(request, identity);
    }
    const receipt = await getApplicationAdapters().previewTraceBroker.list({
      identity,
      query: body.query,
    });
    return json(
      {
        ok: true,
        identity,
        result: {
          traces: receipt.traces,
          services: receipt.services,
          observedAt: receipt.observedAt,
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (cause) {
    if (cause instanceof PreviewTraceQueryError) {
      return json(
        { ok: false, error: cause.message, code: cause.code },
        { status: cause.code === "invalid-request" ? 400 : 409 },
      );
    }
    if (cause instanceof PreviewControlSourceAuthorityError) {
      const status =
        cause.code === "not-found"
          ? 404
          : cause.code === "owner-not-admin"
            ? 403
            : 409;
      return json(
        { ok: false, error: cause.message, code: cause.code },
        { status },
      );
    }
    if (cause instanceof PreviewTraceQueryTimeoutError) {
      return json(
        {
          ok: false,
          error: cause.message,
          code: cause.code,
          details: { range: cause.range, retryRange: cause.retryRange },
        },
        { status: 504, headers: { "retry-after": "1" } },
      );
    }
    if (cause instanceof PreviewTraceQueryUnavailableError) {
      return json({ ok: false, error: cause.message }, { status: 503 });
    }
    throw cause;
  }
};

import { env } from "$env/dynamic/private";
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { validatePreviewControlIdentity } from "$lib/server/application/preview-control-identity";
import {
  PreviewEnvironmentDesiredStateError,
  PreviewRuntimeIdentityChangedError,
  type PreviewControlIdentity,
} from "$lib/server/application/ports";
import { PreviewControlSourceAuthorityError } from "$lib/server/application/preview-control-source-authority";
import { requirePreviewControlCapability } from "$lib/server/internal-auth";
import {
  BoundedJsonBodyError,
  readBoundedJsonObject,
} from "../../../_shared/bounded-json-body";

const MAX_OBSERVATION_BYTES = 16 * 1024;
const IDENTITY_KEYS = [
  "previewName",
  "environmentRequestId",
  "environmentPlatformRevision",
  "environmentSourceRevision",
  "catalogDigest",
] as const;

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
    body = await readBoundedJsonObject(request, MAX_OBSERVATION_BYTES);
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
    !Object.keys(body).every((key) => key === "identity" || key === "view") ||
    (body.view !== "record" && body.view !== "runtime")
  ) {
    return json(
      { ok: false, error: "invalid preview observation command" },
      { status: 400 },
    );
  }

  let identity: PreviewControlIdentity;
  try {
    identity = parseIdentity(body.identity);
  } catch (cause) {
    return json(
      {
        ok: false,
        error:
          cause instanceof Error
            ? cause.message
            : "preview observation identity is invalid",
      },
      { status: 400 },
    );
  }
  requirePreviewControlCapability(request, identity);

  try {
    const observation =
      body.view === "record"
        ? {
            preview:
              await getApplicationAdapters().previewEnvironmentObservationBroker.inspect(
                identity,
              ),
          }
        : {
            runtime:
              await getApplicationAdapters().previewEnvironmentObservationBroker.observeRuntime(
                identity,
              ),
          };
    return json({ ok: true, view: body.view, identity, ...observation }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (cause) {
    if (cause instanceof PreviewRuntimeIdentityChangedError) {
      return json({ ok: false, error: cause.message }, { status: 409 });
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
    if (cause instanceof PreviewEnvironmentDesiredStateError) {
      return json({ ok: false, error: cause.message }, { status: 503 });
    }
    throw cause;
  }
};

function parseIdentity(value: unknown): PreviewControlIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("preview observation identity must be an object");
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== IDENTITY_KEYS.length ||
    !Object.keys(input).every((key) =>
      (IDENTITY_KEYS as readonly string[]).includes(key),
    ) ||
    IDENTITY_KEYS.some((key) => typeof input[key] !== "string")
  ) {
    throw new Error("preview observation identity is invalid");
  }
  return validatePreviewControlIdentity(
    input as unknown as PreviewControlIdentity,
  );
}

import { env } from "$env/dynamic/private";
import { json, type RequestHandler } from "@sveltejs/kit";
import { getApplicationAdapters } from "$lib/server/application";
import type { PreviewAcceptedImageReuseRequest } from "$lib/server/application/ports";
import { PreviewAcceptedImageReuseInputError } from "$lib/server/application/preview-accepted-image-reuse";
import { requirePreviewAcceptedImageReuse } from "$lib/server/internal-auth";
import {
  BoundedJsonBodyError,
  PREVIEW_CONTROL_JSON_MAX_BYTES,
  readBoundedJsonObject,
} from "../../../_shared/bounded-json-body";

const ALLOWED_FIELDS = new Set([
  "repository",
  "mergeSha",
  "context",
  "subject",
]);

/** Physical-only read command. A verified receipt can only select reuse, never write GitOps. */
export const POST: RequestHandler = async ({ request }) => {
  if (env.PREVIEW_CONTROL_BROKER_MODE?.trim().toLowerCase() !== "true") {
    return json({ ok: false, error: "not found" }, { status: 404 });
  }
  requirePreviewAcceptedImageReuse(request);

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
  const unsupported = Object.keys(body).filter(
    (field) => !ALLOWED_FIELDS.has(field),
  );
  if (unsupported.length > 0) {
    return json(
      {
        ok: false,
        error: `unsupported accepted-image fields: ${unsupported.sort().join(", ")}`,
      },
      { status: 400 },
    );
  }

  let command: PreviewAcceptedImageReuseRequest;
  try {
    command = {
      repository: requiredString(body.repository),
      mergeSha: requiredString(body.mergeSha) as never,
      context: requiredString(body.context) as never,
      subject: requiredString(body.subject),
    };
  } catch {
    return json(
      { ok: false, error: "accepted-image reuse command is invalid" },
      { status: 400 },
    );
  }

  try {
    return json(
      await getApplicationAdapters().previewAcceptedImageReuse.resolve(command),
    );
  } catch (cause) {
    if (cause instanceof PreviewAcceptedImageReuseInputError) {
      return json({ ok: false, error: cause.message }, { status: 400 });
    }
    throw cause;
  }
};

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("string required");
  }
  return value.trim();
}

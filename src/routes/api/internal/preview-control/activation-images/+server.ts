import { env } from "$env/dynamic/private";
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type { PreviewActivationGateRequest } from "$lib/server/application/ports";
import { PreviewActivationGateInputError } from "$lib/server/application/preview-activation-gate";
import { requirePreviewControlBroker } from "$lib/server/internal-auth";
import {
  BoundedJsonBodyError,
  PREVIEW_CONTROL_JSON_MAX_BYTES,
  readBoundedJsonObject,
} from "../../_shared/bounded-json-body";

const ALLOWED_FIELDS = new Set(["requestId", "catalogDigest", "pullRequest"]);
const PULL_REQUEST_FIELDS = new Set([
  "repository",
  "number",
  "baseSha",
  "headSha",
]);

/** Physical-only command; caller cannot select artifacts, paths, or status context. */
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
  const unsupported = Object.keys(body).filter(
    (field) => !ALLOWED_FIELDS.has(field),
  );
  if (unsupported.length > 0) {
    return json(
      {
        ok: false,
        error: `unsupported activation fields: ${unsupported.sort().join(", ")}`,
      },
      { status: 400 },
    );
  }

  let command: PreviewActivationGateRequest;
  try {
    const pullRequest = requiredObject(body.pullRequest);
    if (
      Object.keys(pullRequest).some(
        (field) => !PULL_REQUEST_FIELDS.has(field),
      )
    ) {
      throw new Error("unsupported pull request field");
    }
    command = {
      requestId: requiredString(body.requestId),
      catalogDigest: requiredString(body.catalogDigest) as `sha256:${string}`,
      pullRequest: {
        repository: requiredString(pullRequest.repository),
        number: requiredNumber(pullRequest.number),
        baseSha: requiredString(pullRequest.baseSha) as never,
        headSha: requiredString(pullRequest.headSha) as never,
      },
    };
  } catch {
    return json(
      { ok: false, error: "activation command is invalid" },
      { status: 400 },
    );
  }

  try {
    return json(
      await getApplicationAdapters().previewActivationGate.buildAndFinalize(
        command,
      ),
    );
  } catch (cause) {
    if (cause instanceof PreviewActivationGateInputError) {
      return json({ ok: false, error: cause.message }, { status: 409 });
    }
    throw cause;
  }
};

function requiredObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("object required");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("string required");
  }
  return value.trim();
}

function requiredNumber(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error("positive integer required");
  }
  return Number(value);
}

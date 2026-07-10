import { env } from "$env/dynamic/private";
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type { PreviewArtifactTransferEnvelope } from "$lib/server/application/ports";
import { PreviewArtifactIngressError } from "$lib/server/application/preview-artifact-ingress";
import { validatePreviewControlIdentity } from "$lib/server/application/preview-control-identity";
import { requirePreviewControlCapability } from "$lib/server/internal-auth";
import { decodePreviewArtifactEnvelope } from "./preview-artifact-envelope";

const MAX_BYTES = 25 * 1024 * 1024;

export const POST: RequestHandler = async ({ request }) => {
  if (env.PREVIEW_CONTROL_BROKER_MODE?.trim().toLowerCase() !== "true") {
    return json({ ok: false, error: "not found" }, { status: 404 });
  }
  const encoded = request.headers.get("x-preview-artifact-envelope") ?? "";
  let envelope: PreviewArtifactTransferEnvelope;
  try {
    envelope = decodePreviewArtifactEnvelope(encoded);
    validatePreviewControlIdentity(envelope.identity);
  } catch {
    return json(
      { ok: false, error: "artifact envelope is invalid" },
      { status: 400 },
    );
  }
  requirePreviewControlCapability(request, envelope.identity);
  if (request.headers.get("x-content-sha256") !== envelope.fileDigest) {
    return json(
      { ok: false, error: "artifact digest headers disagree" },
      { status: 409 },
    );
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (
    !Number.isSafeInteger(declaredLength) ||
    declaredLength < 1 ||
    declaredLength > MAX_BYTES
  ) {
    return json(
      { ok: false, error: "artifact body length is invalid" },
      { status: 413 },
    );
  }
  const bytes = Buffer.from(await request.arrayBuffer());
  if (bytes.byteLength !== declaredLength || bytes.byteLength > MAX_BYTES) {
    return json(
      { ok: false, error: "artifact body is incomplete or oversized" },
      { status: 413 },
    );
  }
  try {
    const result = await getApplicationAdapters().previewArtifactIngress.ingest(
      envelope,
      bytes,
    );
    return json(result, { status: 201 });
  } catch (cause) {
    if (cause instanceof PreviewArtifactIngressError) {
      return json(
        { ok: false, error: cause.message },
        { status: cause.statusCode },
      );
    }
    throw cause;
  }
};

import { env } from "$env/dynamic/private";
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type {
  PreviewImportedArtifactIdentity,
  PreviewControlIdentity,
  PreviewSourcePromotionBrokerRequest,
} from "$lib/server/application/ports";
import { validatePreviewControlIdentity } from "$lib/server/application/preview-control-identity";
import { PreviewSourcePromotionError } from "$lib/server/application/preview-source-promotion";
import { requirePreviewControlCapability } from "$lib/server/internal-auth";
import {
  BoundedJsonBodyError,
  PREVIEW_CONTROL_JSON_MAX_BYTES,
  readBoundedJsonObject,
} from "../../_shared/bounded-json-body";

const ALLOWED = new Set([
  "operationId",
  "previewName",
  "environmentRequestId",
  "environmentPlatformRevision",
  "environmentSourceRevision",
  "catalogDigest",
  "executionId",
  "hostExecutionId",
  "artifactId",
  "artifactIdentity",
  "title",
  "bodyMarkdown",
  "draft",
]);
const ARTIFACT_IDENTITY_FIELDS = new Set([
  "previewName",
  "requestId",
  "executionId",
  "sourceArtifactId",
  "platformRevision",
  "sourceRevision",
  "catalogDigest",
  "services",
  "captureId",
  "generation",
  "fileDigest",
]);

export const POST: RequestHandler = async ({ request }) => {
  if (
    (
      env.PREVIEW_CONTROL_BROKER_MODE ||
      process.env.PREVIEW_CONTROL_BROKER_MODE ||
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
  const value = body;
  const unexpected = Object.keys(value).filter((key) => !ALLOWED.has(key));
  if (unexpected.length > 0) {
    return json(
      {
        ok: false,
        error: `unsupported promotion fields: ${unexpected.sort().join(", ")}`,
      },
      { status: 400 },
    );
  }
  let identity: PreviewControlIdentity;
  let artifactIdentity: PreviewImportedArtifactIdentity;
  try {
    identity = validatePreviewControlIdentity({
      previewName: requiredString(value.previewName),
      environmentRequestId: requiredString(value.environmentRequestId),
      environmentPlatformRevision: requiredString(
        value.environmentPlatformRevision,
      ),
      environmentSourceRevision: requiredString(
        value.environmentSourceRevision,
      ),
      catalogDigest: requiredString(value.catalogDigest) as `sha256:${string}`,
    });
    artifactIdentity = parseArtifactIdentity(value.artifactIdentity);
  } catch {
    return json(
      { ok: false, error: "promotion identity is invalid" },
      { status: 400 },
    );
  }
  requirePreviewControlCapability(request, identity);
  let command: PreviewSourcePromotionBrokerRequest;
  try {
    if (typeof value.draft !== "boolean") throw new Error("invalid draft");
    command = {
      operationId: requiredString(value.operationId),
      ...identity,
      executionId: requiredString(value.executionId),
      hostExecutionId: optionalString(value.hostExecutionId),
      artifactId: requiredString(value.artifactId),
      artifactIdentity,
      title: optionalString(value.title),
      bodyMarkdown: optionalString(value.bodyMarkdown),
      draft: value.draft,
    };
  } catch {
    return json(
      { ok: false, error: "promotion command is invalid" },
      { status: 400 },
    );
  }
  try {
    const result =
      await getApplicationAdapters().previewSourcePromotionBroker.promote(
        command,
      );
    return json(result);
  } catch (cause) {
    if (cause instanceof PreviewSourcePromotionError) {
      return json(
        { ok: false, error: cause.message, code: cause.code },
        { status: cause.statusCode },
      );
    }
    throw cause;
  }
};

function parseArtifactIdentity(
  value: unknown,
): PreviewImportedArtifactIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("artifact identity is invalid");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !ARTIFACT_IDENTITY_FIELDS.has(key))) {
    throw new Error("artifact identity has unsupported fields");
  }
  if (
    !Array.isArray(record.services) ||
    record.services.length === 0 ||
    !record.services.every((service) => typeof service === "string")
  ) {
    throw new Error("artifact services are invalid");
  }
  return {
    previewName: requiredString(record.previewName),
    requestId: requiredString(record.requestId),
    executionId: requiredString(record.executionId),
    sourceArtifactId: requiredString(record.sourceArtifactId),
    platformRevision: requiredString(record.platformRevision),
    sourceRevision: requiredString(record.sourceRevision),
    catalogDigest: requiredString(record.catalogDigest) as `sha256:${string}`,
    services: [...record.services] as string[],
    captureId: requiredString(record.captureId),
    generation: requiredString(record.generation),
    fileDigest: requiredString(record.fileDigest) as `sha256:${string}`,
  };
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error("required string");
  return value.trim();
}

function optionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return requiredString(value);
}

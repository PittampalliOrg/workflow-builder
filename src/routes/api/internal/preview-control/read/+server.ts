import { json, type RequestHandler } from "@sveltejs/kit";
import { getApplicationAdapters } from "$lib/server/application";
import type { PreviewReadBrokerCommand } from "$lib/server/application/ports";
import { PreviewControlSourceAuthorityError } from "$lib/server/application/preview-control-source-authority";
import { PreviewReadBrokerError } from "$lib/server/application/preview-read-broker";
import { requirePreviewControlBroker } from "$lib/server/internal-auth";
import type { PreviewControlIdentity } from "$lib/server/application/ports";
import {
  BoundedJsonBodyError,
  readBoundedJsonObject,
} from "../../_shared/bounded-json-body";

const MAX_COMMAND_BYTES = 16 * 1024;

export const POST: RequestHandler = async ({ request }) => {
  requirePreviewControlBroker(request);
  let body: Record<string, unknown>;
  try {
    body = await readBoundedJsonObject(request, MAX_COMMAND_BYTES);
  } catch (cause) {
    if (cause instanceof BoundedJsonBodyError) {
      return json({ error: cause.message }, { status: cause.statusCode });
    }
    throw cause;
  }
  if (Object.keys(body).length === 0) {
    return json({ error: "preview read command is empty" }, { status: 400 });
  }
  if (
    Object.keys(body).some(
      (key) => key !== "previewName" && key !== "identity" && key !== "command",
    ) ||
    typeof body.previewName !== "string"
  ) {
    return json(
      { error: "preview read command has unsupported fields" },
      { status: 400 },
    );
  }
  let identity: PreviewControlIdentity;
  try {
    identity = parseIdentity(body.identity);
  } catch (cause) {
    return json(
      {
        error:
          cause instanceof Error
            ? cause.message
            : "invalid preview read identity",
      },
      { status: 400 },
    );
  }
  let command: PreviewReadBrokerCommand;
  try {
    command = parseCommand(body.command);
  } catch (cause) {
    return json(
      {
        error:
          cause instanceof Error
            ? cause.message
            : "invalid preview read operation",
      },
      { status: 400 },
    );
  }

  try {
    const result = await getApplicationAdapters().previewReadBroker.execute({
      previewName: body.previewName,
      identity,
      command,
    });
    if (result.kind === "fetch-file") {
      if (!result.result.ok) {
        return json(result, {
          headers: { "x-preview-read-ok": "false" },
        });
      }
      return new Response(new Uint8Array(result.result.data.bytes), {
        status: 200,
        headers: {
          "cache-control": "no-store",
          "content-length": String(result.result.data.bytes.byteLength),
          "content-type":
            result.result.data.contentType ?? "application/octet-stream",
          "x-preview-read-kind": "fetch-file",
          "x-preview-read-ok": "true",
        },
      });
    }
    return json(result, {
      headers: {
        "cache-control": "no-store",
        "x-preview-read-kind": result.kind,
      },
    });
  } catch (cause) {
    if (cause instanceof PreviewReadBrokerError) {
      const status = cause.code === "invalid-request" ? 400 : 409;
      return json({ error: cause.message, code: cause.code }, { status });
    }
    if (cause instanceof PreviewControlSourceAuthorityError) {
      const status =
        cause.code === "not-found"
          ? 404
          : cause.code === "owner-not-admin"
            ? 403
            : 409;
      return json({ error: cause.message, code: cause.code }, { status });
    }
    throw cause;
  }
};

function parseIdentity(value: unknown): PreviewControlIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("preview read identity must be an object");
  }
  const identity = value as Record<string, unknown>;
  assertKeys(identity, [
    "previewName",
    "environmentRequestId",
    "environmentPlatformRevision",
    "environmentSourceRevision",
    "catalogDigest",
  ]);
  const previewName = identity.previewName;
  const environmentRequestId = identity.environmentRequestId;
  const environmentPlatformRevision = identity.environmentPlatformRevision;
  const environmentSourceRevision = identity.environmentSourceRevision;
  const catalogDigest = identity.catalogDigest;
  if (
    typeof previewName !== "string" ||
    typeof environmentRequestId !== "string" ||
    typeof environmentPlatformRevision !== "string" ||
    typeof environmentSourceRevision !== "string" ||
    typeof catalogDigest !== "string"
  ) {
    throw new Error("preview read identity fields must be strings");
  }
  return {
    previewName,
    environmentRequestId,
    environmentPlatformRevision,
    environmentSourceRevision,
    catalogDigest: catalogDigest as `sha256:${string}`,
  };
}

function parseCommand(value: unknown): PreviewReadBrokerCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("preview read operation must be an object");
  }
  const command = value as Record<string, unknown>;
  switch (command.kind) {
    case "list-executions":
      assertKeys(command, ["kind", "limit", "status"]);
      return {
        kind: command.kind,
        limit: Number(command.limit),
        status: command.status === null ? null : String(command.status ?? ""),
      };
    case "get-execution":
      assertKeys(command, ["kind", "executionId"]);
      return {
        kind: command.kind,
        executionId: String(command.executionId ?? ""),
      };
    case "list-artifacts":
      assertKeys(command, ["kind", "executionId", "artifactKind"]);
      return {
        kind: command.kind,
        executionId: String(command.executionId ?? ""),
        artifactKind:
          command.artifactKind === null
            ? null
            : String(command.artifactKind ?? ""),
      };
    case "fetch-file":
      assertKeys(command, ["kind", "fileId", "maxBytes"]);
      return {
        kind: command.kind,
        fileId: String(command.fileId ?? ""),
        maxBytes: Number(command.maxBytes),
      };
    default:
      throw new Error("unsupported preview read operation");
  }
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const supported = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !supported.has(key));
  if (unexpected.length > 0) {
    throw new Error(
      `unsupported preview read fields: ${unexpected.sort().join(", ")}`,
    );
  }
}

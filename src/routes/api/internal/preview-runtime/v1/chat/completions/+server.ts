import { env } from "$env/dynamic/private";
import { json, type RequestHandler } from "@sveltejs/kit";
import { getApplicationAdapters } from "$lib/server/application";
import { PreviewControlSourceAuthorityError } from "$lib/server/application/preview-control-source-authority";
import {
  PreviewRuntimeBrokerError,
  PreviewRuntimeUpstreamError,
} from "$lib/server/application/preview-runtime-broker";
import { validatePreviewControlIdentity } from "$lib/server/application/preview-control-identity";
import {
  BoundedJsonBodyError,
  readBoundedJsonObject,
} from "../../../../_shared/bounded-json-body";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

export const POST: RequestHandler = async ({ request }) => {
  if (env.PREVIEW_CONTROL_BROKER_MODE?.trim().toLowerCase() !== "true") {
    return json({ error: "not found" }, { status: 404 });
  }
  let identity;
  try {
    identity = validatePreviewControlIdentity({
      previewName:
        request.headers.get("x-preview-environment-name")?.trim() ?? "",
      environmentRequestId:
        request.headers.get("x-preview-environment-request-id")?.trim() ?? "",
      environmentPlatformRevision:
        request.headers
          .get("x-preview-environment-platform-revision")
          ?.trim() ?? "",
      environmentSourceRevision:
        request.headers.get("x-preview-environment-source-revision")?.trim() ??
        "",
      catalogDigest: (request.headers
        .get("x-preview-environment-catalog-digest")
        ?.trim() ?? "") as `sha256:${string}`,
    });
  } catch {
    return json({ error: "invalid preview runtime identity" }, { status: 400 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = await readBoundedJsonObject(request, MAX_REQUEST_BYTES);
  } catch (cause) {
    if (cause instanceof BoundedJsonBodyError) {
      return json({ error: cause.message }, { status: cause.statusCode });
    }
    throw cause;
  }

  try {
    const result = await getApplicationAdapters().previewRuntimeBroker.complete(
      {
        identity,
        capability:
          request.headers.get("x-preview-runtime-capability")?.trim() ?? "",
        payload,
      },
    );
    const headers = new Headers({
      "cache-control": "no-store",
      "content-type": result.contentType,
    });
    if (result.requestId && /^[\x21-\x7e]{1,256}$/.test(result.requestId)) {
      headers.set("x-upstream-request-id", result.requestId);
    }
    return new Response(result.body, { status: result.status, headers });
  } catch (cause) {
    if (cause instanceof PreviewRuntimeBrokerError) {
      const status = {
        unauthorized: 401,
        "invalid-request": 400,
        "model-forbidden": 403,
        capacity: 429,
      }[cause.code];
      return json({ error: cause.message, code: cause.code }, { status });
    }
    if (cause instanceof PreviewControlSourceAuthorityError) {
      const status =
        cause.code === "owner-not-admin"
          ? 403
          : cause.code === "not-found"
            ? 404
            : 409;
      return json({ error: cause.message, code: cause.code }, { status });
    }
    if (cause instanceof PreviewRuntimeUpstreamError) {
      const status =
        cause.code === "timeout"
          ? 504
          : cause.code === "configuration"
            ? 503
            : 502;
      return json({ error: cause.message, code: cause.code }, { status });
    }
    throw cause;
  }
};

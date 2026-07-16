import { env } from "$env/dynamic/private";
import { json, type RequestHandler } from "@sveltejs/kit";
import { getApplicationAdapters } from "$lib/server/application";
import type { PreviewControlIdentity } from "$lib/server/application/ports";
import { PreviewControlSourceAuthorityError } from "$lib/server/application/preview-control-source-authority";
import { PreviewTargetDevelopmentError } from "$lib/server/application/preview-target-development";
import {
  requirePreviewControlBroker,
  requirePreviewControlCapability,
} from "$lib/server/internal-auth";
import {
  BoundedJsonBodyError,
  readBoundedJsonObject,
} from "../../_shared/bounded-json-body";
import { parsePreviewDevelopmentWireRequest } from "../../_shared/preview-target-development";

const MAX_BODY_BYTES = 64 * 1024;

function brokerMode(): boolean {
  return (
    (env.PREVIEW_CONTROL_BROKER_MODE ?? process.env.PREVIEW_CONTROL_BROKER_MODE)
      ?.trim()
      .toLowerCase() === "true"
  );
}

export const POST: RequestHandler = async ({ request }) => {
  const physical = brokerMode();
  if (physical) requirePreviewControlBroker(request);
  let body: Record<string, unknown>;
  try {
    body = await readBoundedJsonObject(request, MAX_BODY_BYTES);
  } catch (cause) {
    if (cause instanceof BoundedJsonBodyError) {
      return json(
        { error: cause.message, code: cause.code },
        { status: cause.statusCode },
      );
    }
    throw cause;
  }

  let input: ReturnType<typeof parsePreviewDevelopmentWireRequest>;
  try {
    input = parsePreviewDevelopmentWireRequest(body);
  } catch (cause) {
    return json(
      {
        error:
          cause instanceof Error
            ? cause.message
            : "invalid preview development command",
        code: "invalid-request",
      },
      { status: 400 },
    );
  }
  if (!physical && input.kind === "verify-promotion") {
    return json(
      {
        error: "promotion receipt verification is physical-broker only",
        code: "invalid-request",
      },
      { status: 400 },
    );
  }
  if (!physical) {
    const identity: PreviewControlIdentity = {
      previewName: input.target.previewName,
      environmentRequestId: input.target.environmentRequestId,
      environmentPlatformRevision: input.target.platformRevision,
      environmentSourceRevision: input.target.sourceRevision,
      catalogDigest: input.target.catalogDigest,
    };
    requirePreviewControlCapability(request, identity);
  }

  try {
    if (input.kind === "verify-promotion") {
      return json(
        await getApplicationAdapters().previewTargetDevelopmentBroker.verifyPromotion(
          input,
        ),
        { headers: { "cache-control": "no-store" } },
      );
    }
    const service = physical
      ? getApplicationAdapters().previewTargetDevelopmentBroker
      : getApplicationAdapters().previewTargetDevelopmentLocal;
    switch (input.kind) {
      case "start-workflow":
        return json(await service.startWorkflow(input), {
          headers: { "cache-control": "no-store" },
        });
      case "get-workflow-status":
        return json(await service.getWorkflowStatus(input), {
          headers: { "cache-control": "no-store" },
        });
      case "signal-workflow":
        return json(await service.signalWorkflow(input), {
          headers: { "cache-control": "no-store" },
        });
    }
  } catch (cause) {
    if (cause instanceof PreviewTargetDevelopmentError) {
      return json(
        { error: cause.message, code: cause.code },
        { status: statusFor(cause.code) },
      );
    }
    if (cause instanceof PreviewControlSourceAuthorityError) {
      const code =
        cause.code === "not-found"
          ? "not-found"
          : cause.code === "not-ready"
            ? "not-ready"
            : cause.code === "owner-not-admin"
              ? "unauthorized"
              : "contract-mismatch";
      return json({ error: cause.message, code }, { status: statusFor(code) });
    }
    throw cause;
  }
};

function statusFor(code: PreviewTargetDevelopmentError["code"]): number {
  switch (code) {
    case "invalid-request":
      return 400;
    case "unauthorized":
      return 403;
    case "not-found":
      return 404;
    case "not-ready":
      return 425;
    case "contract-mismatch":
      return 409;
    case "upstream-failure":
      return 502;
  }
}

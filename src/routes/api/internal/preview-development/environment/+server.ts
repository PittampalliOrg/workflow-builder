import { json, type RequestHandler } from "@sveltejs/kit";
import { getApplicationAdapters } from "$lib/server/application";
import { PreviewDevelopmentEnvironmentError } from "$lib/server/application/preview-development-environment";
import { requirePreviewActionInternal } from "$lib/server/internal-auth";
import {
  BoundedJsonBodyError,
  readBoundedJsonObject,
} from "../../_shared/bounded-json-body";
import { parsePreviewDevelopmentEnvironmentRequest } from "../../_shared/preview-development-environment";

const MAX_BODY_BYTES = 64 * 1024;

export const POST: RequestHandler = async ({ request }) => {
  requirePreviewActionInternal(request);
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

  try {
    const parsed = parsePreviewDevelopmentEnvironmentRequest(body);
    const environments = getApplicationAdapters().previewDevelopmentEnvironment;
    switch (parsed.command.kind) {
      case "launch-environment":
        return json(
          await environments.launchEnvironment({
            parentExecutionId: parsed.parentExecutionId,
            operationId: parsed.command.operationId,
            launch: parsed.command.input,
          }),
          { headers: { "cache-control": "no-store" } },
        );
      case "get-environment-status":
        return json(
          await environments.getEnvironmentStatus({
            parentExecutionId: parsed.parentExecutionId,
            operationId: parsed.command.operationId,
            target: parsed.command.target,
          }),
          { headers: { "cache-control": "no-store" } },
        );
      case "teardown-environment":
        return json(
          await environments.teardownEnvironment({
            parentExecutionId: parsed.parentExecutionId,
            operationId: parsed.command.operationId,
            target: parsed.command.target,
          }),
          { headers: { "cache-control": "no-store" } },
        );
      case "get-environment-teardown-status":
        return json(
          await environments.getEnvironmentTeardownStatus({
            parentExecutionId: parsed.parentExecutionId,
            operationId: parsed.command.operationId,
            target: parsed.command.target,
            ticket: parsed.command.ticket,
          }),
          { headers: { "cache-control": "no-store" } },
        );
    }
  } catch (cause) {
    if (cause instanceof PreviewDevelopmentEnvironmentError) {
      return json(
        { error: cause.message, code: cause.code },
        { status: statusFor(cause.code) },
      );
    }
    if (cause instanceof Error) {
      return json(
        { error: cause.message, code: "invalid-request" },
        { status: 400 },
      );
    }
    throw cause;
  }
};

function statusFor(code: PreviewDevelopmentEnvironmentError["code"]): number {
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

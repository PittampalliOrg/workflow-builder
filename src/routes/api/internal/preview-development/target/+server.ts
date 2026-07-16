import { json, type RequestHandler } from "@sveltejs/kit";
import { getApplicationAdapters } from "$lib/server/application";
import { PreviewTargetDevelopmentError } from "$lib/server/application/preview-target-development";
import { requirePreviewActionInternal } from "$lib/server/internal-auth";
import {
  BoundedJsonBodyError,
  readBoundedJsonObject,
} from "../../_shared/bounded-json-body";
import { parsePreviewDevelopmentHostRequest } from "../../_shared/preview-target-development";

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
    const parsed = parsePreviewDevelopmentHostRequest(body);
    const target = getApplicationAdapters().previewTargetDevelopment;
    switch (parsed.command.kind) {
      case "start-workflow":
        return json(
          await target.startWorkflow({
            parentExecutionId: parsed.parentExecutionId,
            operationId: parsed.command.operationId,
            target: parsed.command.target,
            workflowInput: parsed.command.input,
          }),
          { headers: { "cache-control": "no-store" } },
        );
      case "get-workflow-status":
        return json(
          await target.getWorkflowStatus({
            parentExecutionId: parsed.parentExecutionId,
            operationId: parsed.command.operationId,
            target: parsed.command.target,
            workflow: {
              executionId: parsed.command.executionId,
              workflowName: "microservice-dev-session",
              workflowSpecDigest: parsed.command.workflowSpecDigest,
            },
          }),
          { headers: { "cache-control": "no-store" } },
        );
      case "signal-workflow":
        return json(
          await target.signalWorkflow({
            parentExecutionId: parsed.parentExecutionId,
            operationId: parsed.command.operationId,
            target: parsed.command.target,
            workflow: {
              executionId: parsed.command.executionId,
              workflowName: "microservice-dev-session",
              workflowSpecDigest: parsed.command.workflowSpecDigest,
            },
            action: parsed.command.action,
          }),
          { headers: { "cache-control": "no-store" } },
        );
      case "verify-promotion":
        return json(
          await target.verifyPromotion({
            parentExecutionId: parsed.parentExecutionId,
            operationId: parsed.command.operationId,
            target: parsed.command.target,
            childExecutionId: parsed.command.childExecutionId,
            receiptId: parsed.command.receiptId,
            services: parsed.command.services,
          }),
          { headers: { "cache-control": "no-store" } },
        );
    }
  } catch (cause) {
    if (cause instanceof PreviewTargetDevelopmentError) {
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

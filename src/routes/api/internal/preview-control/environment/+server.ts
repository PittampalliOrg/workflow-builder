import { env } from "$env/dynamic/private";
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type { PreviewEnvironmentUserLaunchInput } from "$lib/server/application/ports";
import { PreviewEnvironmentLaunchAuthorizationError } from "$lib/server/application/preview-environment-launch-broker";
import {
  PreviewEnvironmentOperatorActionRequiredError,
  PreviewEnvironmentRevisionResolutionError,
  PreviewEnvironmentUnavailableError,
  PreviewEnvironmentValidationError,
} from "$lib/server/application/preview-environments";
import { requirePreviewControlBroker } from "$lib/server/internal-auth";
import {
  BoundedJsonBodyError,
  PREVIEW_CONTROL_JSON_MAX_BYTES,
  readBoundedJsonObject,
} from "../../_shared/bounded-json-body";

const ALLOWED = new Set([
  "name",
  "userId",
	"workflowExecutionId",
  "profile",
  "lane",
  "capabilities",
  "platformRevision",
  "platformRef",
  "sourceRevision",
  "sourceRef",
  "services",
  "candidatePaths",
  "ttlHours",
  "lifecycle",
  "allocation",
  "provenance",
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
  const value = body;
  const unexpected = Object.keys(value).filter((key) => !ALLOWED.has(key));
  if (
    unexpected.length > 0 ||
    typeof value.name !== "string" ||
		typeof value.userId !== "string" ||
		(value.workflowExecutionId !== undefined && typeof value.workflowExecutionId !== "string")
  ) {
    return json(
      {
        ok: false,
        error:
          unexpected.length > 0
            ? `unsupported environment launch fields: ${unexpected.sort().join(", ")}`
            : "environment launch identity is invalid",
      },
      { status: 400 },
    );
  }
  try {
    const result =
      await getApplicationAdapters().previewEnvironmentLaunchBroker.launchForUser(
        value as PreviewEnvironmentUserLaunchInput,
      );
    return json(result);
  } catch (cause) {
    if (cause instanceof PreviewEnvironmentLaunchAuthorizationError) {
      return json({ ok: false, error: cause.message }, { status: 403 });
    }
    if (cause instanceof PreviewEnvironmentValidationError) {
      return json(
        { ok: false, error: cause.message, issues: cause.issues },
        { status: 400 },
      );
    }
    if (cause instanceof PreviewEnvironmentOperatorActionRequiredError) {
      return json({ ok: false, error: cause.message }, { status: 409 });
    }
    if (cause instanceof PreviewEnvironmentRevisionResolutionError) {
      return json({ ok: false, error: cause.message }, { status: 502 });
    }
    if (cause instanceof PreviewEnvironmentUnavailableError) {
      return json({ ok: false, error: cause.message }, { status: 503 });
    }
    throw cause;
  }
};

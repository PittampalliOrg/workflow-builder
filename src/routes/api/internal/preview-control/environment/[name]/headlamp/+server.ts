import { env } from "$env/dynamic/private";
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import {
  PreviewHeadlampRegistrationError,
  type PreviewHeadlampRegistrationCommand,
} from "$lib/server/application/ports";
import {
  validatePreviewHeadlampRegistrationCommand,
} from "$lib/server/application/preview-headlamp-registration";
import { requirePreviewControlCapability } from "$lib/server/internal-auth";
import {
  BoundedJsonBodyError,
  readBoundedJsonObject,
} from "../../../../_shared/bounded-json-body";

const MAX_HEADLAMP_REGISTRATION_BYTES = 48 * 1024;

export const POST: RequestHandler = async ({ request, params }) => {
  if (
    (env.PREVIEW_CONTROL_BROKER_MODE ?? process.env.PREVIEW_CONTROL_BROKER_MODE)
      ?.trim()
      .toLowerCase() !== "true"
  ) {
    return json({ ok: false, error: "not found" }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await readBoundedJsonObject(
      request,
      MAX_HEADLAMP_REGISTRATION_BYTES,
    );
  } catch (cause) {
    if (cause instanceof BoundedJsonBodyError) {
      return json(
        { ok: false, error: cause.message },
        { status: cause.statusCode },
      );
    }
    throw cause;
  }

  let command: PreviewHeadlampRegistrationCommand;
  try {
    command = validatePreviewHeadlampRegistrationCommand(body);
  } catch (cause) {
    if (cause instanceof PreviewHeadlampRegistrationError) {
      return json({ ok: false, error: cause.message }, { status: 400 });
    }
    throw cause;
  }
  if (params.name !== command.identity.previewName) {
    return json(
      { ok: false, error: "preview Headlamp path identity is invalid" },
      { status: 400 },
    );
  }

  requirePreviewControlCapability(request, command.identity);
  try {
    const registration =
      await getApplicationAdapters().previewHeadlampRegistration.register(
        command,
      );
    return json(
      { ok: true, registration },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  } catch (cause) {
    if (cause instanceof PreviewHeadlampRegistrationError) {
      const status =
        cause.code === "invalid-input"
          ? 400
          : cause.code === "hub-unavailable"
            ? 503
            : 409;
      return json(
        { ok: false, error: cause.message, code: cause.code },
        { status, headers: { "cache-control": "no-store" } },
      );
    }
    throw cause;
  }
};

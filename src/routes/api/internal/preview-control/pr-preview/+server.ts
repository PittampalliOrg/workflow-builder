import { env } from "$env/dynamic/private";
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { PrPreviewAdmissionError } from "$lib/server/application/pr-previews";
import { requirePreviewControlBroker } from "$lib/server/internal-auth";
import {
  BoundedJsonBodyError,
  PREVIEW_CONTROL_JSON_MAX_BYTES,
  readBoundedJsonObject,
} from "../../_shared/bounded-json-body";

const FIELDS = {
  up: new Set(["action", "prNumber", "headSha", "verify"]),
  down: new Set(["action", "prNumber"]),
  status: new Set(["action", "prNumber"]),
} as const;

/** Immutable-broker command endpoint. GitHub and cluster credentials stay here. */
export const POST: RequestHandler = async ({ request }) => {
  if (
    (env.PREVIEW_CONTROL_BROKER_MODE ?? process.env.PREVIEW_CONTROL_BROKER_MODE)
      ?.trim()
      .toLowerCase() !== "true"
  ) {
    return json({ error: "not found" }, { status: 404 });
  }
  requirePreviewControlBroker(request);
  let body: Record<string, unknown>;
  try {
    body = await readBoundedJsonObject(request, PREVIEW_CONTROL_JSON_MAX_BYTES);
  } catch (cause) {
    if (cause instanceof BoundedJsonBodyError) {
      return json({ error: cause.message }, { status: cause.statusCode });
    }
    throw cause;
  }
  const action =
    body.action === "up" || body.action === "down" || body.action === "status"
      ? body.action
      : null;
  if (!action) {
    return json(
      { error: "action must be up, down, or status" },
      { status: 400 },
    );
  }
  const unsupported = Object.keys(body).filter(
    (key) => !FIELDS[action].has(key),
  );
  if (unsupported.length > 0) {
    return json(
      {
        error: `unsupported broker fields: ${unsupported.sort().join(", ")}`,
      },
      { status: 400 },
    );
  }
  const prNumber = Number(body.prNumber);
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) {
    return json(
      { error: "prNumber must be a positive integer" },
      { status: 400 },
    );
  }

  const previews = getApplicationAdapters().prPreviews;
  try {
    if (action === "down") {
      return json(await previews.down({ prNumber }));
    }
    if (action === "status") {
      return json(await previews.status(prNumber));
    }
    const headSha = typeof body.headSha === "string" ? body.headSha : "";
    if (!headSha) {
      return json({ error: "headSha is required" }, { status: 400 });
    }
    return json(
      await previews.up({
        prNumber,
        headSha,
        verify: typeof body.verify === "boolean" ? body.verify : undefined,
      }),
      { status: 202 },
    );
  } catch (error) {
    if (error instanceof PrPreviewAdmissionError) {
      const status =
        error.code === "invalid-request"
          ? 400
          : error.code === "teardown-failed"
            ? 409
            : 422;
      return json({ error: error.message, code: error.code }, { status });
    }
    throw error;
  }
};

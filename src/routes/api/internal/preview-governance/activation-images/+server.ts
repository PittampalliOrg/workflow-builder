import { env } from "$env/dynamic/private";
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { requirePreviewGovernanceDispatch } from "$lib/server/internal-auth";
import {
  BoundedJsonBodyError,
  PREVIEW_CONTROL_JSON_MAX_BYTES,
  readBoundedJsonObject,
} from "../../_shared/bounded-json-body";

const TOP_LEVEL_FIELDS = new Set(["pullRequest"]);
const PULL_REQUEST_FIELDS = new Set([
  "repository",
  "number",
  "baseSha",
  "headSha",
]);

/** Normal-BFF ingress; every activation/build/status field is server-owned. */
export const POST: RequestHandler = async ({ request }) => {
  if (
    (env.PREVIEW_CONTROL_BROKER_MODE ?? process.env.PREVIEW_CONTROL_BROKER_MODE)
      ?.trim()
      .toLowerCase() === "true"
  ) {
    return json({ ok: false, error: "not found" }, { status: 404 });
  }
  requirePreviewGovernanceDispatch(request);

  let body: Record<string, unknown>;
  try {
    body = await readBoundedJsonObject(request, PREVIEW_CONTROL_JSON_MAX_BYTES);
  } catch (cause) {
    if (cause instanceof BoundedJsonBodyError) {
      return json({ ok: false, error: cause.message }, { status: cause.statusCode });
    }
    throw cause;
  }
  if (Object.keys(body).some((field) => !TOP_LEVEL_FIELDS.has(field))) {
    return json({ ok: false, error: "unsupported activation dispatch field" }, { status: 400 });
  }

  let pullRequest: Record<string, unknown>;
  try {
    pullRequest = requiredObject(body.pullRequest);
    if (Object.keys(pullRequest).some((field) => !PULL_REQUEST_FIELDS.has(field))) {
      throw new Error("unsupported pull request field");
    }
  } catch {
    return json(
      { ok: false, error: "activation dispatch tuple is invalid" },
      { status: 400 },
    );
  }

  try {
    return json(
      await getApplicationAdapters().previewActivationDispatch.dispatch({
        pullRequest: {
          repository: requiredString(pullRequest.repository),
          number: requiredNumber(pullRequest.number),
          baseSha: requiredString(pullRequest.baseSha) as never,
          headSha: requiredString(pullRequest.headSha) as never,
        },
      }),
    );
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes("tuple is invalid")) {
      return json({ ok: false, error: cause.message }, { status: 400 });
    }
    throw cause;
  }
};

function requiredObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("activation dispatch tuple is invalid");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("activation dispatch tuple is invalid");
  }
  return value.trim();
}

function requiredNumber(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error("activation dispatch tuple is invalid");
  }
  return Number(value);
}

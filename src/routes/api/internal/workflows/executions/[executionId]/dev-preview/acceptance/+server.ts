import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { requirePreviewActionInternal } from "$lib/server/internal-auth";

const ALLOWED_FIELDS = new Set(["pullRequest"]);
const ALLOWED_PULL_REQUEST_FIELDS = new Set([
  "repository",
  "number",
  "baseSha",
  "headSha",
]);
const FULL_SHA = /^[0-9a-f]{40}$/;

/** Mutable preview BFF proxy. It deliberately owns no GitHub, build, admin, or cluster authority. */
export const POST: RequestHandler = async ({ params, request }) => {
  requirePreviewActionInternal(request);
  if (!params.executionId) throw error(400, "executionId required");
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw error(400, "request body must be a JSON object");
  }
  const unexpected = Object.keys(body).filter(
    (key) => !ALLOWED_FIELDS.has(key),
  );
  if (unexpected.length > 0) {
    throw error(
      400,
      `unsupported acceptance fields: ${unexpected.sort().join(", ")}`,
    );
  }
  const pullRequest = (body as Record<string, unknown>).pullRequest;
  if (
    !pullRequest ||
    typeof pullRequest !== "object" ||
    Array.isArray(pullRequest)
  ) {
    throw error(400, "pullRequest must be an object");
  }
  const pullRequestRecord = pullRequest as Record<string, unknown>;
  const unexpectedPullRequestFields = Object.keys(pullRequestRecord).filter(
    (key) => !ALLOWED_PULL_REQUEST_FIELDS.has(key),
  );
  if (
    unexpectedPullRequestFields.length > 0 ||
    typeof pullRequestRecord.repository !== "string" ||
    !Number.isSafeInteger(pullRequestRecord.number) ||
    Number(pullRequestRecord.number) < 1 ||
    typeof pullRequestRecord.baseSha !== "string" ||
    !FULL_SHA.test(pullRequestRecord.baseSha) ||
    typeof pullRequestRecord.headSha !== "string" ||
    !FULL_SHA.test(pullRequestRecord.headSha) ||
    pullRequestRecord.baseSha === pullRequestRecord.headSha
  ) {
    throw error(
      400,
      "pullRequest must contain only an exact repository, number, baseSha, and headSha tuple",
    );
  }
  const app = getApplicationAdapters();
  const identity = app.previewLocalControlIdentity.current();
  const result = await app.previewAcceptanceBroker.replay({
    requestId: globalThis.crypto.randomUUID(),
    previewName: identity.previewName,
    pullRequest: pullRequestRecord as never,
  });
  return json(result, { status: result.ok ? 200 : 422 });
};

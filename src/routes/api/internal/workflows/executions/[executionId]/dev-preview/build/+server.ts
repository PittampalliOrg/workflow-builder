import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { PreviewDevelopmentBuildInputError } from "$lib/server/application/preview-development-build";
import { requirePreviewActionInternal } from "$lib/server/internal-auth";

const ALLOWED_FIELDS = new Set(["services", "origin", "adopt"]);

type BuildBody = {
  services?: unknown;
  origin?: unknown;
  adopt?: unknown;
};

export const POST: RequestHandler = async ({ params, request }) => {
  requirePreviewActionInternal(request);
  if (!params.executionId) {
    return json({ ok: false, error: "executionId required" }, { status: 400 });
  }
  const raw = await request.json().catch(() => null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return json(
      { ok: false, error: "request body must be a JSON object" },
      { status: 400 },
    );
  }
  const unexpected = Object.keys(raw).filter((key) => !ALLOWED_FIELDS.has(key));
  if (unexpected.length > 0) {
    return json(
      {
        ok: false,
        error: `unsupported request fields: ${unexpected.sort().join(", ")}`,
      },
      { status: 400 },
    );
  }
  const body = raw as BuildBody;
  if (!Array.isArray(body.services)) {
    return json(
      { ok: false, error: "services must be a non-empty array" },
      { status: 400 },
    );
  }
  if (typeof body.origin !== "string") {
    return json(
      { ok: false, error: "origin must be the preview HTTPS origin" },
      { status: 400 },
    );
  }
  const app = getApplicationAdapters();
  const identity = app.previewLocalControlIdentity.current();
  let originHost = "";
  try {
    originHost = new URL(body.origin).hostname;
  } catch {
    return json({ ok: false, error: "origin is invalid" }, { status: 400 });
  }
  if (!originHost.startsWith(`wfb-${identity.previewName}.`)) {
    return json(
      { ok: false, error: "origin does not identify this preview environment" },
      { status: 409 },
    );
  }
  if (typeof body.adopt !== "boolean") {
    return json(
      { ok: false, error: "adopt must explicitly choose true or false" },
      { status: 400 },
    );
  }

  const executionId = await app.workflowData.resolveCanonicalExecutionId({
    executionId: params.executionId,
  });
  const execution = await app.workflowData.getExecutionById(executionId);
  if (!execution) {
    return json({ ok: false, error: "execution not found" }, { status: 404 });
  }
  if (!(await app.workflowData.isPlatformAdmin(execution.userId))) {
    return json(
      {
        ok: false,
        error: "platform admin approval is required for development builds",
      },
      { status: 403 },
    );
  }

  try {
    const result = await app.previewDevelopmentBuild.buildAndReprovision({
      executionId,
      services: body.services as readonly string[],
      origin: body.origin,
      adopt: body.adopt,
    });
    const status =
      result.stage === "complete"
        ? result.ok
          ? 200
          : 207
        : result.stage === "broker"
          ? 502
          : 409;
    return json(result, { status });
  } catch (cause) {
    if (cause instanceof PreviewDevelopmentBuildInputError) {
      return json({ ok: false, error: cause.message }, { status: 400 });
    }
    throw cause;
  }
};

/**
 * POST /api/internal/workflows/executions/[executionId]/dev-preview/promote
 *
 * Internal-only "promote-from-best": open a GitHub PR from a dev-pod-as-source
 * (in-preview GAN) run. Resolves the durable `source-bundle` version for the
 * requested iteration (`"best"` → `bestIteration`, a number → that iteration,
 * null/absent → capture live now), transfers the immutable artifact to the
 * physical control broker, and asks that broker to branch + open the PR. The
 * preview receives no GitHub write credential.
 *
 * Failures return HTTP 200 with `{ ok: false, error }` (the workflow needs the
 * reason as data, not an opaque 500). Auth: requires PREVIEW_ACTION_INTERNAL_TOKEN.
 */

import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { requirePreviewActionInternal } from "$lib/server/internal-auth";
import type { WorkflowArtifactRecord } from "$lib/server/application/ports";

const SOURCE_BUNDLE_KIND = "source-bundle";
const PREVIEW_DEVELOPMENT_CONTEXT_KEY = "__previewDevelopment";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ALLOWED_FIELDS = new Set([
  "iteration",
  "bestIteration",
  "draft",
  "title",
  "bodyMarkdown",
  "services",
]);

type Body = {
  iteration?: number | "best" | null;
  bestIteration?: number | null;
  draft?: boolean;
  title?: string;
  bodyMarkdown?: string;
  services?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeExpectedServices(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw.flatMap((value) => (readString(value) ? [readString(value)!] : [])),
    ),
  ].sort();
}

function previewDevelopmentHostExecutionId(input: unknown): string | null {
  const context = asRecord(asRecord(input)[PREVIEW_DEVELOPMENT_CONTEXT_KEY]);
  const parentExecutionId = context.parentExecutionId;
  return typeof parentExecutionId === "string" && SAFE_ID.test(parentExecutionId)
    ? parentExecutionId
    : null;
}

function iterationOf(artifact: WorkflowArtifactRecord): number | null {
  const payload = asRecord(artifact.inlinePayload);
  const raw = payload.iteration;
  return typeof raw === "number" && Number.isFinite(raw)
    ? Math.floor(raw)
    : null;
}

export const POST: RequestHandler = async ({ params, request }) => {
  requirePreviewActionInternal(request);
  const rawId = params.executionId;
  if (!rawId)
    return json({ ok: false, error: "executionId required" }, { status: 400 });

  const app = getApplicationAdapters();
  const workflowData = app.workflowData;
  // The orchestrator passes the Dapr instance id; the execution + artifact rows
  // are keyed on the canonical execution id (same as the sibling snapshot route).
  const executionId = await workflowData.resolveCanonicalExecutionId({
    executionId: rawId,
  });
  const execution = await workflowData.getExecutionById(executionId);
  if (!execution) {
    return json({ ok: false, error: "execution not found" }, { status: 404 });
  }
  if (!(await workflowData.isPlatformAdmin(execution.userId))) {
    return json(
      {
        ok: false,
        error: "platform admin approval is required for source promotion",
      },
      { status: 403 },
    );
  }
  const hostExecutionId = previewDevelopmentHostExecutionId(execution.input);

  let body: Body = {};
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return json({ ok: false, error: "request body must be an object" });
    }
    const unsupported = Object.keys(parsed).filter(
      (key) => !ALLOWED_FIELDS.has(key),
    );
    if (unsupported.length > 0) {
      return json({
        ok: false,
        error: `unsupported promotion fields: ${unsupported.sort().join(", ")}`,
      });
    }
    body = parsed as Body;
  } catch {
    /* empty body is allowed → capture-live path */
  }

  const iterationField = body.iteration;
  const bestIteration =
    typeof body.bestIteration === "number" &&
    Number.isFinite(body.bestIteration)
      ? Math.floor(body.bestIteration)
      : null;
  // Resolve which iteration the caller wants a bundle for:
  //  - "best"          → bestIteration (else latest bundle regardless of iteration)
  //  - <number>        → that iteration
  //  - null / absent   → no target; capture live now
  let targetIteration: number | null = null;
  let wantLatest = false;
  let captureLive = false;
  if (iterationField === "best") {
    if (bestIteration != null) targetIteration = bestIteration;
    else wantLatest = true;
  } else if (
    typeof iterationField === "number" &&
    Number.isFinite(iterationField)
  ) {
    targetIteration = Math.floor(iterationField);
  } else {
    captureLive = true;
  }

  // Resolve an existing source-bundle artifact unless the caller asked for the
  // live path.
  let artifact: WorkflowArtifactRecord | null = null;
  if (!captureLive) {
    try {
      const all =
        await workflowData.listWorkflowArtifactsByExecutionId(executionId);
      const bundles = all
        .filter((a) => a.kind === SOURCE_BUNDLE_KIND && a.fileId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      if (wantLatest) {
        artifact = bundles[0] ?? null;
      } else if (targetIteration != null) {
        artifact =
          bundles.find((a) => iterationOf(a) === targetIteration) ?? null;
      }
    } catch (err) {
      return json({
        ok: false,
        error: `failed to list source bundles: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // No stored bundle (missing iteration, or caller wanted live): capture the dev
  // pod's current source via /__export and promote that.
  if (!artifact) {
    const expectedServices = normalizeExpectedServices(body.services);
    if (expectedServices.length === 0) {
      return json({ ok: false, error: "missing_expected_services" });
    }
    const captured =
      await app.devPreviewSourceCapture.captureAcceptanceCandidate({
        executionId,
        nodeId: "dev-preview",
        iteration: targetIteration,
        expectedServices,
      });
    if (!captured.ok || !captured.artifactId) {
      return json({
        ok: false,
        error: `no_source_bundle${captured.skipped ? `: ${captured.skipped}` : ""}`,
        services: captured.services,
      });
    }
    artifact = await workflowData.getWorkflowArtifactForExecution({
      executionId,
      artifactId: captured.artifactId,
    });
    if (!artifact?.fileId) {
      return json({ ok: false, error: "captured bundle has no file" });
    }
  }

  try {
    const result = await app.previewSourcePromotion.promote({
      executionId,
      hostExecutionId,
      artifactId: artifact.id,
      title: readString(body.title),
      bodyMarkdown: readString(body.bodyMarkdown),
      draft: true,
    });
    return json(result);
  } catch (cause) {
    return json({
      ok: false,
      error: `source_promotion_failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
};

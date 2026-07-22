import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type { WorkflowExecutionReadModelPatch } from "$lib/server/application/ports";
import {
  requireInternal,
  requireInternalOrPreviewControlRead,
} from "$lib/server/internal-auth";

const ALLOWED_PATCH_KEYS = new Set([
  "status",
  "phase",
  "progress",
  "output",
  "error",
  "summaryOutput",
  "currentNodeId",
  "currentNodeName",
  "primaryTraceId",
  "workflowSessionId",
  "completedAt",
  "duration",
]);

function normalizeCompletedAt(value: unknown): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string")
    throw new Error("completedAt must be an ISO string or null");
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new Error("completedAt must be a valid ISO date");
  return date;
}

export const GET: RequestHandler = async ({ params, request }) => {
  requireInternalOrPreviewControlRead(request);
  const executionId = params.executionId?.trim();
  if (!executionId) return error(400, "executionId required");

  const execution =
    await getApplicationAdapters().workflowData.getExecutionById(executionId);
  if (!execution) return error(404, `execution ${executionId} not found`);
  return json({ execution });
};

export const PATCH: RequestHandler = async ({ params, request }) => {
  requireInternal(request);
  const executionId = params.executionId?.trim();
  if (!executionId) return error(400, "executionId required");

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return error(400, "JSON object body required");
  }

  const { workflowData, workflowExecutionRuntimeHosts } =
    getApplicationAdapters();
  const patch: WorkflowExecutionReadModelPatch = {};
  try {
    for (const [key, value] of Object.entries(body)) {
      if (!ALLOWED_PATCH_KEYS.has(key)) continue;
      Object.assign(patch, {
        [key]: key === "completedAt" ? normalizeCompletedAt(value) : value,
      });
    }
  } catch (err) {
    return error(
      400,
      err instanceof Error ? err.message : "invalid execution patch",
    );
  }
  if (Object.keys(patch).length === 0)
    return error(400, "no supported execution fields supplied");

  const result = await workflowData.applyExecutionRuntimeProjection(
    executionId,
    patch,
  );
  if (!result.applied && result.reason === "not_found") {
    return error(404, `execution ${executionId} not found`);
  }
  if (
    result.applied &&
    (patch.status === "success" ||
      patch.status === "error" ||
      patch.status === "cancelled")
  ) {
    workflowExecutionRuntimeHosts.requestReap();
  }
  return json({ ok: true, ...result });
};

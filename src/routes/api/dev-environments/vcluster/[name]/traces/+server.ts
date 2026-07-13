import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { PreviewAccessDeniedError } from "$lib/server/application/preview-access";
import { PreviewRuntimeIdentityChangedError } from "$lib/server/application/ports";
import {
  PreviewTraceQueryError,
  PreviewTraceQueryUnavailableError,
} from "$lib/server/application/preview-traces";

export const GET: RequestHandler = async ({ params, locals, url }) => {
  const actorUserId = locals.session?.userId;
  if (!actorUserId) return error(401, "Authentication required");
  const adapters = getApplicationAdapters();
  if (!adapters.previewDeploymentScope.allowsPreviewName(params.name)) {
    return error(
      403,
      "Cross-preview access is unavailable from a preview deployment",
    );
  }
  const rawLimit = url.searchParams.get("limit");
  try {
    const receipt = await adapters.previewTraces.list({
      name: params.name,
      actorUserId,
      query: {
        range: url.searchParams.get("range") || undefined,
        status: url.searchParams.get("status") || undefined,
        service: url.searchParams.get("service") || undefined,
        search: url.searchParams.get("search") || undefined,
        limit: rawLimit == null ? undefined : Number(rawLimit),
      },
    });
    return json(
      {
        traces: receipt.traces,
        services: receipt.services,
        observedAt: receipt.observedAt,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (cause) {
    if (cause instanceof PreviewAccessDeniedError)
      return error(403, cause.message);
    if (cause instanceof PreviewRuntimeIdentityChangedError)
      return error(409, cause.message);
    if (cause instanceof PreviewTraceQueryError) {
      return error(cause.code === "invalid-request" ? 400 : 409, cause.message);
    }
    if (cause instanceof PreviewTraceQueryUnavailableError)
      return error(503, cause.message);
    throw cause;
  }
};

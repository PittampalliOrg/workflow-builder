import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { guardPreviewMcp, previewMcpError } from "../../guard";

/** Exact-generation, bounded trace summaries through the observability application port. */
export const GET: RequestHandler = async ({ request, params, url }) => {
  const guard = await guardPreviewMcp(request, {
    requiredScope: "workflow:read",
    previewName: params.name,
  });
  if (!guard.ok) return guard.response;
  const rawLimit = url.searchParams.get("limit");
  try {
    const receipt = await guard.app.previewTraces.list({
      name: params.name,
      actorUserId: guard.principal.userId,
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
    return previewMcpError(cause);
  }
};

/**
 * GET /api/internal/files/[id]/content
 *
 * Internal-token blob fetch — the in-cluster counterpart to the session-scoped
 * `/api/v1/files/[id]/content`. Lets a workspace helper pod (e.g. the Promote → PR
 * rehydrator) pull a stored git bundle with `INTERNAL_API_TOKEN` instead of a user
 * session. Auth: requires INTERNAL_API_TOKEN.
 */

import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternalOrPreviewControlRead } from "$lib/server/internal-auth";
import { getFileContent } from "$lib/server/files/registry";

export const GET: RequestHandler = async ({ params, request }) => {
  requireInternalOrPreviewControlRead(request);
  const result = await getFileContent(params.id);
  if (!result) return error(404, "File not found");
  const { summary, bytes } = result;
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": summary.contentType || "application/octet-stream",
      "Content-Length": String(summary.sizeBytes),
      "Content-Disposition": `attachment; filename="${encodeURIComponent(summary.name)}"`,
      "Cache-Control": "private, max-age=300",
    },
  });
};

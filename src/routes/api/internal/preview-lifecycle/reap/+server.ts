import { json, type RequestHandler } from "@sveltejs/kit";
import { getApplicationAdapters } from "$lib/server/application";
import { requirePreviewActionInternal } from "$lib/server/internal-auth";

export const POST: RequestHandler = async ({ request }) => {
  requirePreviewActionInternal(request);
  return json(
    await getApplicationAdapters().previewLifecycleReaper.reapExpired(),
  );
};

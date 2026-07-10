import { env } from "$env/dynamic/private";
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { PreviewEnvironmentDesiredStateError } from "$lib/server/application/ports";
import { requirePreviewControlBroker } from "$lib/server/internal-auth";

export const POST: RequestHandler = async ({ request }) => {
  if (
    (
      env.PREVIEW_CONTROL_BROKER_MODE ||
      process.env.PREVIEW_CONTROL_BROKER_MODE ||
      ""
    )
      .trim()
      .toLowerCase() !== "true"
  ) {
    return json({ ok: false, error: "not found" }, { status: 404 });
  }
  requirePreviewControlBroker(request);
  try {
    const result =
      await getApplicationAdapters().previewEnvironmentDeletionReconciler.reconcile();
    const ok =
      result.failed === 0 &&
      result.pruneFailed === 0 &&
      result.runtimeBudgetPruneFailed === 0;
    return json({ ok, ...result }, { status: ok ? 200 : 503 });
  } catch (cause) {
    if (cause instanceof PreviewEnvironmentDesiredStateError) {
      return json({ ok: false, error: cause.message }, { status: 503 });
    }
    throw cause;
  }
};

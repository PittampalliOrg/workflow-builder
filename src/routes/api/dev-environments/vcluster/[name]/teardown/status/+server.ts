import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import {
  PreviewEnvironmentDesiredStateError,
  PreviewEnvironmentDesiredStateOwnershipError,
} from "$lib/server/application/ports";
import { requirePlatformAdmin } from "$lib/server/platform-admin";

const SHA = /^[0-9a-f]{40}$/;
const SIGNATURE = /^[0-9a-f]{64}$/;

/** Read-only physical cleanup progress for a previously accepted teardown. */
export const GET: RequestHandler = async ({ params, locals, url }) => {
  if (!locals.session?.userId) return error(401, "Authentication required");
  const adapters = getApplicationAdapters();
  if (!adapters.previewDeploymentScope.isControlPlane()) {
    return error(
      403,
      "Preview fleet operations are unavailable from a preview deployment",
    );
  }
  await requirePlatformAdmin(locals);
  const environmentUid = url.searchParams.get("environmentUid") ?? "";
  const requestId = url.searchParams.get("requestId") ?? "";
  const sourceRevision = url.searchParams.get("sourceRevision") ?? "";
  const signature = url.searchParams.get("signature") ?? "";
  if (
    !environmentUid ||
    environmentUid.length > 128 ||
    !requestId ||
    requestId.length > 256 ||
    !SHA.test(sourceRevision) ||
    !SIGNATURE.test(signature)
  ) {
    return error(400, "A valid teardown ticket is required");
  }
  const ticket = {
    name: params.name,
    environmentUid,
    requestId,
    sourceRevision,
    signature,
  };
  try {
    const teardown = await adapters.vclusterPreviews.teardownStatus(ticket);
    return json(
      { teardown, ticket },
      {
        status: teardown.phase === "pending" ? 202 : 200,
        ...(teardown.phase === "pending"
          ? { headers: { "retry-after": "5" } }
          : {}),
      },
    );
  } catch (cause) {
    if (cause instanceof PreviewEnvironmentDesiredStateOwnershipError) {
      return error(409, cause.message);
    }
    if (cause instanceof PreviewEnvironmentDesiredStateError) {
      return error(503, cause.message);
    }
    throw cause;
  }
};

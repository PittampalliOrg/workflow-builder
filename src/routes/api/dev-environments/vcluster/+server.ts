import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { PreviewEnvironmentLaunchAuthorizationError } from "$lib/server/application/preview-environment-launch-broker";
import {
  PreviewEnvironmentRevisionResolutionError,
  PreviewEnvironmentUnavailableError,
  PreviewEnvironmentValidationError,
} from "$lib/server/application/preview-environments";
import {
  safePreviewName,
  type PreviewEnvironmentLaunchRequest,
} from "$lib/types/dev-previews";
import { requirePlatformAdmin } from "$lib/server/platform-admin";

/** List Tier-2 (vcluster full-isolation) previews + A3/A4 capacity counts. */
export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.session?.userId) return error(401, "Authentication required");
  const adapters = getApplicationAdapters();
  if (!adapters.previewDeploymentScope.isControlPlane()) {
    return error(403, "Preview fleet operations are unavailable from a preview deployment");
  }
  await requirePlatformAdmin(locals);
  const { previews, counts } = await adapters.vclusterPreviews.list();
  return json({ previews, counts });
};

/**
 * Launch a validated PreviewEnvironment. Legacy `{name}` remains app-live;
 * revisions and trusted provenance are resolved/created by the application
 * service before an infrastructure adapter is selected.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.session?.userId) return error(401, "Authentication required");
  const adapters = getApplicationAdapters();
  if (!adapters.previewDeploymentScope.isControlPlane()) {
    return error(403, "Preview fleet operations are unavailable from a preview deployment");
  }
  await requirePlatformAdmin(locals);
  const body = (await request
    .json()
    .catch(() => ({}))) as Partial<PreviewEnvironmentLaunchRequest>;
  const name = safePreviewName(body.name ?? "");
  if (!name || name === "preview")
    return error(400, "A preview name is required");

  let result;
  try {
    const infrastructureProfile =
      body.profile && body.profile !== "app-live" ? body.profile : null;
    if (infrastructureProfile) {
      const pullRequestNumber = body.pullRequest?.number;
      if (
        !Number.isInteger(pullRequestNumber) ||
        (pullRequestNumber ?? 0) < 1
      ) {
        return error(
          400,
          "Infrastructure previews require a positive stacks pull request number",
        );
      }
      const brokered = await adapters.previewInfrastructureCandidates.launch({
        requestId: globalThis.crypto.randomUUID(),
        name,
        userId: locals.session.userId,
        pullRequestNumber: pullRequestNumber!,
        ...(body.ttlHours === undefined ? {} : { ttlHours: body.ttlHours }),
        ...(body.lifecycle === "ephemeral" || body.lifecycle === "retained"
          ? { lifecycle: body.lifecycle }
          : {}),
      });
      if (brokered.status === "operator-required") {
        return error(
          409,
          `${brokered.profile} requires the operator-controlled ${brokered.operatorAction.command} lane`,
        );
      }
      result = adapters.vclusterPreviews.presentLaunch(brokered.launch);
    } else {
      const outcome = await adapters.previewEnvironments.launchForUser({
        name,
        userId: locals.session.userId,
        profile: body.profile,
        capabilities: body.capabilities,
        platformRevision: body.platformRevision,
        platformRef: body.platformRef,
        sourceRevision: body.sourceRevision,
        sourceRef: body.sourceRef,
        services: body.services,
        ttlHours: body.ttlHours,
        lifecycle: body.lifecycle,
        allocation: body.allocation,
        provenance:
          body.provenance?.parentEnvironmentId == null
            ? undefined
            : {
                parentEnvironmentId: body.provenance.parentEnvironmentId,
              },
      });
      result = adapters.vclusterPreviews.presentLaunch(outcome);
    }
  } catch (cause) {
    if (cause instanceof PreviewEnvironmentLaunchAuthorizationError) {
      return error(403, cause.message);
    }
    if (cause instanceof PreviewEnvironmentValidationError) {
      return error(400, cause.message);
    }
    if (cause instanceof PreviewEnvironmentRevisionResolutionError) {
      return error(502, cause.message);
    }
    if (cause instanceof PreviewEnvironmentUnavailableError) {
      return error(501, cause.message);
    }
    throw cause;
  }
  if (!result.ok) return error(429, result.message);
  return json(
    { preview: result.preview, pooled: result.pooled },
    { status: 202 },
  );
};

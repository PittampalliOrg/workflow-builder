import { json } from "@sveltejs/kit";
import { getApplicationAdapters } from "$lib/server/application";
import { validateInternalToken } from "$lib/server/internal-auth";
import { PreviewAccessDeniedError } from "$lib/server/application/preview-access";
import { PreviewEnvironmentLaunchAuthorizationError } from "$lib/server/application/preview-environment-launch-broker";
import {
  PreviewEnvironmentRevisionResolutionError,
  PreviewEnvironmentUnavailableError,
  PreviewEnvironmentValidationError,
} from "$lib/server/application/preview-environments";
import { PreviewDeploymentScopeDeniedError } from "$lib/server/application/preview-deployment-scope";
import { PreviewTeardownRefusedError } from "$lib/server/application/preview-teardown";
import {
  PreviewTraceQueryError,
  PreviewTraceQueryUnavailableError,
} from "$lib/server/application/preview-traces";
import {
  PreviewEnvironmentDesiredStateError,
  PreviewEnvironmentDesiredStateOwnershipError,
  PreviewRuntimeIdentityChangedError,
} from "$lib/server/application/ports";
import { resolveInternalWorkflowPrincipal } from "../workflow-mcp-principal";

type ApplicationAdapters = ReturnType<typeof getApplicationAdapters>;
type AuthorizedPrincipal = Extract<
  Awaited<
    ReturnType<ApplicationAdapters["internalWorkflowPrincipal"]["authorize"]>
  >,
  { ok: true }
>["principal"];

export type PreviewMcpGuardResult =
  | {
      ok: true;
      app: ApplicationAdapters;
      principal: AuthorizedPrincipal;
    }
  | { ok: false; response: Response };

function errorResponse(
  status: number,
  code: string,
  message: string,
  headers?: Record<string, string>,
): Response {
  return json(
    { error: { code, message } },
    { status, ...(headers ? { headers } : {}) },
  );
}

/** Authenticate the service and signed workspace principal before any preview use case. */
export async function guardPreviewMcp(
  request: Request,
  input: {
    requiredScope: "workflow:read" | "workflow:execute";
    admin?: boolean;
    controlPlane?: boolean;
    previewName?: string;
  },
): Promise<PreviewMcpGuardResult> {
  if (!validateInternalToken(request)) {
    return {
      ok: false,
      response: errorResponse(401, "unauthorized", "Unauthorized"),
    };
  }
  const app = getApplicationAdapters();
  const principal = await resolveInternalWorkflowPrincipal(
    request,
    app.internalWorkflowPrincipal,
    { requiredScope: input.requiredScope },
  );
  if (!principal.ok) {
    return {
      ok: false,
      response: errorResponse(
        principal.status,
        "preview_principal_denied",
        principal.error,
      ),
    };
  }
  if (
    input.controlPlane === true &&
    !app.previewDeploymentScope.isControlPlane()
  ) {
    return {
      ok: false,
      response: errorResponse(
        403,
        "preview_control_plane_required",
        "Preview fleet operations are unavailable from a preview deployment",
      ),
    };
  }
  if (
    input.previewName !== undefined &&
    !app.previewDeploymentScope.allowsPreviewName(input.previewName)
  ) {
    return {
      ok: false,
      response: errorResponse(
        403,
        "preview_cross_environment_denied",
        "Cross-preview access is unavailable from a preview deployment",
      ),
    };
  }
  if (
    input.admin === true &&
    !(await app.workflowData.isPlatformAdmin(principal.principal.userId))
  ) {
    return {
      ok: false,
      response: errorResponse(
        403,
        "preview_admin_required",
        "Platform admin approval is required for this preview operation",
      ),
    };
  }
  return { ok: true, app, principal: principal.principal };
}

/** Stable HTTP error mapping for the Workflow MCP preview adapter. */
export function previewMcpError(cause: unknown): Response {
  if (
    cause instanceof PreviewAccessDeniedError ||
    cause instanceof PreviewEnvironmentLaunchAuthorizationError ||
    cause instanceof PreviewDeploymentScopeDeniedError
  ) {
    return errorResponse(403, "preview_access_denied", cause.message);
  }
  if (cause instanceof PreviewEnvironmentValidationError) {
    return errorResponse(400, "preview_invalid_request", cause.message);
  }
  if (cause instanceof PreviewEnvironmentRevisionResolutionError) {
    return errorResponse(502, "preview_revision_resolution_failed", cause.message);
  }
  if (
    cause instanceof PreviewRuntimeIdentityChangedError ||
    cause instanceof PreviewEnvironmentDesiredStateOwnershipError
  ) {
    return errorResponse(409, "preview_generation_changed", cause.message);
  }
  if (cause instanceof PreviewTeardownRefusedError) {
    return errorResponse(409, cause.code, cause.message);
  }
  if (cause instanceof PreviewTraceQueryError) {
    return errorResponse(
      cause.code === "invalid-request" ? 400 : 409,
      `preview_trace_${cause.code.replaceAll("-", "_")}`,
      cause.message,
    );
  }
  if (
    cause instanceof PreviewEnvironmentUnavailableError ||
    cause instanceof PreviewTraceQueryUnavailableError ||
    cause instanceof PreviewEnvironmentDesiredStateError
  ) {
    return errorResponse(
      503,
      "preview_service_unavailable",
      cause.message,
      { "retry-after": "5" },
    );
  }
  throw cause;
}

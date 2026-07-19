import type { ApplicationInternalWorkflowPrincipalService } from "$lib/server/application/internal-workflow-principal";
import type { LegacyWorkflowRuntimeResource } from "$lib/server/application/ports/workflow-mcp-auth";

export const WORKFLOW_MCP_PRINCIPAL_ASSERTION_HEADER =
  "x-wfb-principal-assertion";

/** Map the internal HTTP adapter onto the application authorization command. */
export function resolveInternalWorkflowPrincipal(
  request: Request,
  authorizer: Pick<ApplicationInternalWorkflowPrincipalService, "authorize">,
  options: {
    requiredScope?: string;
    legacyResource?: LegacyWorkflowRuntimeResource;
  } = {},
) {
  return authorizer.authorize({
    assertionToken: request.headers
      .get(WORKFLOW_MCP_PRINCIPAL_ASSERTION_HEADER)
      ?.trim(),
    platformToken:
      request.headers.get("x-wfb-session-token")?.trim() || undefined,
    legacyUserId:
      request.headers.get("x-wfb-principal-user-id")?.trim() || undefined,
    legacyProjectId:
      request.headers.get("x-wfb-principal-project-id")?.trim() || undefined,
    sessionId: request.headers.get("x-wfb-session-id")?.trim() || null,
    requiredScope: options.requiredScope,
    legacyResource: options.legacyResource,
  });
}

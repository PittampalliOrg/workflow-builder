import { getApplicationAdapters } from "$lib/server/application";
import type {
  TeamActionAuthorizationResult,
  TeamActionRequiredRole,
} from "$lib/server/application/team-action-authorization";
import { validateInternalToken } from "$lib/server/internal-auth";

const USER_PRINCIPAL_HEADERS = [
  "x-wfb-principal-assertion",
  "x-wfb-session-token",
  "x-wfb-principal-user-id",
  "x-wfb-principal-project-id",
] as const;

type TeamActionRequestOptions = {
  bodySessionId?: string | null;
  requiredRole?: TeamActionRequiredRole;
  allowUnformedLeadTeam?: boolean;
};

/** HTTP adapter for the application team-action authorization use case. */
export async function authorizeTeamActionRequest(
  request: Request,
  teamId: string,
  options: TeamActionRequestOptions = {},
): Promise<
  TeamActionAuthorizationResult | { ok: false; status: 401; error: string }
> {
  if (!validateInternalToken(request)) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  const systemPrincipal = request.headers.get("x-wfb-system-principal")?.trim();
  const headerSessionId =
    request.headers.get("x-wfb-session-id")?.trim() || null;
  const carriesUserPrincipal = USER_PRINCIPAL_HEADERS.some((header) =>
    request.headers.has(header),
  );
  if (systemPrincipal && carriesUserPrincipal) {
    return {
      ok: false,
      status: 403,
      error: "System and user team principals cannot be combined",
    };
  }

  const authorizer = getApplicationAdapters().teamActionAuthorization;
  if (systemPrincipal) {
    return authorizer.authorizeSystem({
      systemPrincipal,
      teamId,
      sessionId: options.bodySessionId ?? headerSessionId,
      requiredRole: options.requiredRole,
    });
  }

  if (
    options.bodySessionId &&
    headerSessionId &&
    options.bodySessionId !== headerSessionId
  ) {
    return {
      ok: false,
      status: 403,
      error: "Body session lineage does not match the signed team principal",
    };
  }
  return authorizer.authorizeUser({
    assertionToken:
      request.headers.get("x-wfb-principal-assertion")?.trim() || undefined,
    platformToken:
      request.headers.get("x-wfb-session-token")?.trim() || undefined,
    legacyUserId:
      request.headers.get("x-wfb-principal-user-id")?.trim() || undefined,
    legacyProjectId:
      request.headers.get("x-wfb-principal-project-id")?.trim() || undefined,
    teamId,
    sessionId: headerSessionId,
    requiredRole: options.requiredRole,
    allowUnformedLeadTeam: options.allowUnformedLeadTeam,
  });
}

/** Keep runtime-only child credentials out of MCP tool result content. */
export function publicPeerSpawnProjection(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const publicBody = { ...body };
  delete publicBody.workflowMcpSessionToken;
  return publicBody;
}

import type {
  SessionRuntimeStartAuthorityPort,
  SessionRuntimeStartAuthorizationResult,
} from "$lib/server/application/ports";

export type SessionRuntimeStartPrincipal = {
  userId: string;
  projectId: string;
  sessionId: string;
  teamId: string | null;
  teamRole: "none" | "lead" | "member";
};

export type SessionRuntimeStartAuthorityResult =
  | { status: "authorized" }
  | {
      status: "error";
      httpStatus: 403 | 404 | 409;
      code:
        | "session_not_found"
        | "session_principal_mismatch"
        | "session_inactive"
        | "parent_inactive"
        | "team_pending"
        | "team_inactive"
        | "runtime_superseded"
        | "runtime_unpublished";
      message: string;
      retryable: boolean;
    };

export class ApplicationSessionRuntimeStartAuthorityService {
  constructor(private readonly authority: SessionRuntimeStartAuthorityPort) {}

  async authorize(
    sessionId: string,
    runtimeAppId: string,
    runtimeInstanceId: string,
    principal: SessionRuntimeStartPrincipal,
  ): Promise<SessionRuntimeStartAuthorityResult> {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId || normalizedSessionId !== principal.sessionId) {
      return {
        status: "error",
        httpStatus: 403,
        code: "session_principal_mismatch",
        message: "Start authority must match the signed session",
        retryable: false,
      };
    }
    const normalizedRuntimeAppId = runtimeAppId.trim();
    const normalizedRuntimeInstanceId = runtimeInstanceId.trim();
    if (!normalizedRuntimeAppId || !normalizedRuntimeInstanceId) {
      return {
        status: "error",
        httpStatus: 409,
        code: "runtime_superseded",
        message: "Calling runtime identity is missing",
        retryable: false,
      };
    }

    return mapAuthorizationResult(
      await this.authority.authorizeSessionRuntimeStart({
        sessionId: normalizedSessionId,
        runtimeAppId: normalizedRuntimeAppId,
        runtimeInstanceId: normalizedRuntimeInstanceId,
        userId: principal.userId,
        projectId: principal.projectId,
        teamId: principal.teamId,
        teamRole: principal.teamRole,
      }),
    );
  }
}

function mapAuthorizationResult(
  result: SessionRuntimeStartAuthorizationResult,
): SessionRuntimeStartAuthorityResult {
  switch (result.status) {
    case "authorized":
      return result;
    case "not_found":
      return {
        status: "error",
        httpStatus: 404,
        code: "session_not_found",
        message: "Session start target was not found",
        retryable: false,
      };
    case "principal_mismatch":
      return {
        status: "error",
        httpStatus: 403,
        code: "session_principal_mismatch",
        message: "Session start target is outside the signed workspace",
        retryable: false,
      };
    case "parent_inactive":
      return {
        status: "error",
        httpStatus: 409,
        code: "parent_inactive",
        message: "Session parent is stopping or terminal",
        retryable: false,
      };
    case "team_pending":
      return {
        status: "error",
        httpStatus: 409,
        code: "team_pending",
        message: "Team membership is still being activated",
        retryable: true,
      };
    case "team_inactive":
      return {
        status: "error",
        httpStatus: 409,
        code: "team_inactive",
        message: "Team membership is missing or inactive",
        retryable: false,
      };
    case "runtime_unpublished":
      return {
        status: "error",
        httpStatus: 409,
        code: "runtime_unpublished",
        message: "Session runtime target has not been published",
        retryable: true,
      };
    case "runtime_superseded":
      return {
        status: "error",
        httpStatus: 409,
        code: "runtime_superseded",
        message: "Session runtime has been replaced by a newer generation",
        retryable: false,
      };
    case "inactive":
      return {
        status: "error",
        httpStatus: 409,
        code: "session_inactive",
        message: "Session is stopping or terminal",
        retryable: false,
      };
  }
}

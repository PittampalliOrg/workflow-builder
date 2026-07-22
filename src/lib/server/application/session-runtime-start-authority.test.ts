import { describe, expect, it, vi } from "vitest";
import type { SessionRuntimeStartAuthorityPort } from "./ports";
import { ApplicationSessionRuntimeStartAuthorityService } from "./session-runtime-start-authority";

describe("ApplicationSessionRuntimeStartAuthorityService", () => {
  it("rejects mismatched signed lineage before touching persistence", async () => {
    const authority: SessionRuntimeStartAuthorityPort = {
      authorizeSessionRuntimeStart: vi.fn(async () => ({
        status: "authorized" as const,
      })),
    };
    const service = new ApplicationSessionRuntimeStartAuthorityService(
      authority,
    );

    await expect(
      service.authorize("child-1", "agent-session-child", "child-runtime-1", {
        userId: "user-1",
        projectId: "project-1",
        sessionId: "other-child",
        teamId: null,
        teamRole: "none",
      }),
    ).resolves.toMatchObject({
      status: "error",
      httpStatus: 403,
      code: "session_principal_mismatch",
    });
    expect(authority.authorizeSessionRuntimeStart).not.toHaveBeenCalled();
  });

  it("maps the atomic port result into the application contract", async () => {
    const authority: SessionRuntimeStartAuthorityPort = {
      authorizeSessionRuntimeStart: vi.fn(async () => ({
        status: "parent_inactive" as const,
      })),
    };
    const service = new ApplicationSessionRuntimeStartAuthorityService(
      authority,
    );

    await expect(
      service.authorize("child-1", "agent-session-child", "child-runtime-1", {
        userId: "user-1",
        projectId: "project-1",
        sessionId: "child-1",
        teamId: "team-1",
        teamRole: "member",
      }),
    ).resolves.toEqual({
      status: "error",
      httpStatus: 409,
      code: "parent_inactive",
      message: "Session parent is stopping or terminal",
      retryable: false,
    });
    expect(authority.authorizeSessionRuntimeStart).toHaveBeenCalledWith({
      sessionId: "child-1",
      runtimeAppId: "agent-session-child",
      runtimeInstanceId: "child-runtime-1",
      userId: "user-1",
      projectId: "project-1",
      teamId: "team-1",
      teamRole: "member",
    });
  });

  it("marks only publication and team activation gaps retryable", async () => {
    const authorizeSessionRuntimeStart = vi
      .fn()
      .mockResolvedValueOnce({ status: "team_pending" as const })
      .mockResolvedValueOnce({ status: "runtime_unpublished" as const })
      .mockResolvedValueOnce({ status: "team_inactive" as const });
    const service = new ApplicationSessionRuntimeStartAuthorityService({
      authorizeSessionRuntimeStart,
    });
    const principal = {
      userId: "user-1",
      projectId: "project-1",
      sessionId: "child-1",
      teamId: "team-1",
      teamRole: "member" as const,
    };

    await expect(
      service.authorize(
        "child-1",
        "agent-session-child",
        "child-runtime-1",
        principal,
      ),
    ).resolves.toMatchObject({
      code: "team_pending",
      retryable: true,
    });
    await expect(
      service.authorize(
        "child-1",
        "agent-session-child",
        "child-runtime-1",
        principal,
      ),
    ).resolves.toMatchObject({
      code: "runtime_unpublished",
      retryable: true,
    });
    await expect(
      service.authorize(
        "child-1",
        "agent-session-child",
        "child-runtime-1",
        principal,
      ),
    ).resolves.toMatchObject({
      code: "team_inactive",
      retryable: false,
    });
  });

  it("maps a replaced runtime generation to a non-retryable denial", async () => {
    const service = new ApplicationSessionRuntimeStartAuthorityService({
      authorizeSessionRuntimeStart: vi.fn(async () => ({
        status: "runtime_superseded" as const,
      })),
    });

    await expect(
      service.authorize("child-1", "agent-session-old", "child-runtime-old", {
        userId: "user-1",
        projectId: "project-1",
        sessionId: "child-1",
        teamId: null,
        teamRole: "none",
      }),
    ).resolves.toEqual({
      status: "error",
      httpStatus: 409,
      code: "runtime_superseded",
      message: "Session runtime has been replaced by a newer generation",
      retryable: false,
    });
  });
});

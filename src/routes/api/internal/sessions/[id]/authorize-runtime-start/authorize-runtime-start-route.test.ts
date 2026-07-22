import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  validateInternalToken: vi.fn(() => true),
  internalWorkflowPrincipal: {
    authorize: vi.fn(
      async (): Promise<
        | {
            ok: true;
            principal: {
              userId: string;
              projectId: string;
              sessionId: string | null;
              scopes: string[];
              capabilities: {
                scriptDepth: number;
                teamId: string | null;
                teamRole: "none" | "lead" | "member";
              };
            };
          }
        | { ok: false; status: 400 | 403 | 404; error: string }
      > => ({
        ok: true as const,
        principal: {
          userId: "user-1",
          projectId: "project-1",
          sessionId: "child-1",
          scopes: ["workflow:execute"],
          capabilities: {
            scriptDepth: 0,
            teamId: null,
            teamRole: "none" as const,
          },
        },
      }),
    ),
  },
  sessionRuntimeStartAuthority: {
    authorize: vi.fn(
      async (): Promise<
        | { status: "authorized" }
        | {
            status: "error";
            httpStatus: 403 | 404 | 409;
            code: string;
            message: string;
            retryable: boolean;
          }
      > => ({ status: "authorized" as const }),
    ),
  },
}));

vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    internalWorkflowPrincipal: mocks.internalWorkflowPrincipal,
    sessionRuntimeStartAuthority: mocks.sessionRuntimeStartAuthority,
  }),
}));

vi.mock("$lib/server/internal-auth", () => ({
  validateInternalToken: mocks.validateInternalToken,
}));

import { POST } from "./+server";

function event(
  sessionId = "child-1",
  runtimeAppId = "agent-session-child",
  runtimeInstanceId = "child-runtime-1",
) {
  return {
    request: new Request(
      `http://localhost/api/internal/sessions/${sessionId}/authorize-runtime-start`,
      {
        method: "POST",
        headers: {
          "X-Internal-Token": "internal",
          "X-Wfb-Session-Id": sessionId,
          "X-Wfb-Session-Token": "signed-child-token",
        },
        body: JSON.stringify({ runtimeAppId, runtimeInstanceId }),
      },
    ),
    params: { id: sessionId },
  };
}

async function expectHttpStatus(promise: Promise<unknown>, status: number) {
  try {
    const result = await promise;
    expect((result as { status?: number }).status).toBe(status);
  } catch (err) {
    expect((err as { status?: number }).status).toBe(status);
  }
}

describe("internal session runtime start authority route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateInternalToken.mockReturnValue(true);
    mocks.internalWorkflowPrincipal.authorize.mockResolvedValue({
      ok: true,
      principal: {
        userId: "user-1",
        projectId: "project-1",
        sessionId: "child-1",
        scopes: ["workflow:execute"],
        capabilities: {
          scriptDepth: 0,
          teamId: null,
          teamRole: "none",
        },
      },
    });
    mocks.sessionRuntimeStartAuthority.authorize.mockResolvedValue({
      status: "authorized",
    });
  });

  it("requires the service token and signed session principal", async () => {
    mocks.validateInternalToken.mockReturnValueOnce(false);
    await expectHttpStatus(Promise.resolve(POST(event() as never)), 401);
    expect(mocks.internalWorkflowPrincipal.authorize).not.toHaveBeenCalled();

    mocks.internalWorkflowPrincipal.authorize.mockResolvedValueOnce({
      ok: false,
      status: 403,
      error: "invalid session token",
    });
    const response = (await POST(event() as never)) as Response;
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      authorized: false,
      retryable: false,
      code: "session_principal_unauthorized",
      message: "invalid session token",
      sessionId: "child-1",
      runtimeAppId: "agent-session-child",
      runtimeInstanceId: "child-runtime-1",
    });
    expect(mocks.sessionRuntimeStartAuthority.authorize).not.toHaveBeenCalled();
  });

	it("delegates the exact signed session to the application command", async () => {
		mocks.internalWorkflowPrincipal.authorize.mockResolvedValueOnce({
			ok: true,
			principal: {
				userId: "user-1",
				projectId: "project-1",
				sessionId: "child-1",
				scopes: ["workflow:execute"],
				capabilities: {
					scriptDepth: 0,
					teamId: "team-1",
					teamRole: "member",
				},
			},
		});
		const response = (await POST(event() as never)) as Response;

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      authorized: true,
      sessionId: "child-1",
      runtimeAppId: "agent-session-child",
      runtimeInstanceId: "child-runtime-1",
    });
    expect(mocks.sessionRuntimeStartAuthority.authorize).toHaveBeenCalledWith(
      "child-1",
      "agent-session-child",
      "child-runtime-1",
      {
        userId: "user-1",
        projectId: "project-1",
        sessionId: "child-1",
				teamId: "team-1",
				teamRole: "member",
      },
    );
  });

  it("requires an immutable calling runtime identity", async () => {
    await expectHttpStatus(
      Promise.resolve(POST(event("child-1", "") as never)),
      400,
    );
    expect(mocks.sessionRuntimeStartAuthority.authorize).not.toHaveBeenCalled();
    await expectHttpStatus(
      Promise.resolve(
        POST(event("child-1", "agent-session-child", "") as never),
      ),
      400,
    );
    expect(mocks.sessionRuntimeStartAuthority.authorize).not.toHaveBeenCalled();
  });

  it("rejects principal lineage mismatch and application denial", async () => {
    mocks.internalWorkflowPrincipal.authorize.mockResolvedValueOnce({
      ok: true,
      principal: {
        userId: "user-1",
        projectId: "project-1",
        sessionId: "other-child",
        scopes: ["workflow:execute"],
        capabilities: {
          scriptDepth: 0,
          teamId: null,
          teamRole: "none",
        },
      },
    });
    const mismatch = (await POST(event() as never)) as Response;
    expect(mismatch.status).toBe(403);
    await expect(mismatch.json()).resolves.toEqual({
      authorized: false,
      retryable: false,
      code: "session_principal_mismatch",
      message: "Start authority must match the signed session",
      sessionId: "child-1",
      runtimeAppId: "agent-session-child",
      runtimeInstanceId: "child-runtime-1",
    });

    mocks.sessionRuntimeStartAuthority.authorize.mockResolvedValueOnce({
      status: "error",
      httpStatus: 409,
      code: "session_inactive",
      message: "Session is stopping or terminal",
      retryable: false,
    });
    await expectHttpStatus(Promise.resolve(POST(event() as never)), 409);
  });

  it("returns a structured retry contract for transient start gaps", async () => {
    mocks.sessionRuntimeStartAuthority.authorize.mockResolvedValueOnce({
      status: "error",
      httpStatus: 409,
      code: "team_pending",
      message: "Team membership is still being activated",
      retryable: true,
    });

    const response = (await POST(event() as never)) as Response;
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      authorized: false,
			retryable: true,
			code: "team_pending",
			message: "Team membership is still being activated",
			sessionId: "child-1",
      runtimeAppId: "agent-session-child",
      runtimeInstanceId: "child-runtime-1",
    });
  });

  it("returns runtime_superseded as a structured non-retryable denial", async () => {
    mocks.sessionRuntimeStartAuthority.authorize.mockResolvedValueOnce({
      status: "error",
      httpStatus: 409,
      code: "runtime_superseded",
      message: "Session runtime has been replaced by a newer generation",
      retryable: false,
    });

    const response = (await POST(event() as never)) as Response;
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      authorized: false,
      retryable: false,
      code: "runtime_superseded",
      message: "Session runtime has been replaced by a newer generation",
      sessionId: "child-1",
      runtimeAppId: "agent-session-child",
      runtimeInstanceId: "child-runtime-1",
    });
  });
});

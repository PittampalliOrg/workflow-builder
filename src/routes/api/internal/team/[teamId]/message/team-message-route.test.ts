import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  getMemberByName: vi.fn(),
  getMemberBySession: vi.fn(),
  injectTeamMessage: vi.fn(),
}));

vi.mock("$lib/server/teams/team-repo", () => ({
  getMemberByName: mocks.getMemberByName,
  getMemberBySession: mocks.getMemberBySession,
}));
vi.mock("$lib/server/teams/team-messaging", () => ({
  injectTeamMessage: mocks.injectTeamMessage,
}));
vi.mock("../../team-action-principal", () => ({
  authorizeTeamActionRequest: mocks.authorize,
}));

import { POST } from "./+server";

function event() {
  return {
    params: { teamId: "team-1" },
    request: new Request(
      "http://workflow-builder/api/internal/team/team-1/message",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fromSessionId: "lead-1",
          to: "worker",
          content: "Please continue",
        }),
      },
    ),
  };
}

describe("team direct message route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorize.mockResolvedValue({
      ok: true,
      principal: { sessionId: "lead-1" },
    });
    mocks.getMemberByName.mockResolvedValue({
      name: "worker",
      session_id: "child-1",
      status: "working",
    });
    mocks.getMemberBySession.mockResolvedValue({ name: "lead" });
  });

  it("returns a retryable conflict without appending to a starting child", async () => {
    mocks.getMemberByName.mockResolvedValueOnce({
      name: "worker",
      session_id: "child-1",
      status: "starting",
    });

    const response = (await POST(event() as never)) as Response;

    expect(response.status).toBe(409);
    expect(response.headers.get("retry-after")).toBe("1");
    await expect(response.json()).resolves.toEqual({
      ok: false,
      state: "starting",
      retryable: true,
      message: "teammate 'worker' is still starting",
    });
    expect(mocks.getMemberBySession).not.toHaveBeenCalled();
    expect(mocks.injectTeamMessage).not.toHaveBeenCalled();
  });

  it("delivers normally after membership is working", async () => {
    const response = (await POST(event() as never)) as Response;

    expect(response.status).toBe(200);
    expect(mocks.injectTeamMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientSessionId: "child-1",
        fromName: "lead",
        content: "Please continue",
        kind: "teammate-message",
      }),
    );
  });
});

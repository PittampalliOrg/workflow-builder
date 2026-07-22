import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  getTeam: vi.fn(),
  getMemberByName: vi.fn(),
  setMemberPlanApproved: vi.fn(),
  injectTeamMessage: vi.fn(),
}));

vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    teamStore: {
      getTeam: mocks.getTeam,
      getMemberByName: mocks.getMemberByName,
      setMemberPlanApproved: mocks.setMemberPlanApproved,
    },
  }),
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
      "http://workflow-builder/api/internal/team/team-1/plan-approval",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestedBySessionId: "lead-1",
          name: "worker",
          approved: true,
        }),
      },
    ),
  };
}

describe("team plan approval route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorize.mockResolvedValue({
      ok: true,
      principal: { sessionId: "lead-1" },
    });
    mocks.getTeam.mockResolvedValue({ id: "team-1" });
    mocks.getMemberByName.mockResolvedValue({
      name: "worker",
      session_id: "child-1",
      status: "working",
      plan_mode_required: true,
    });
  });

  it("returns a retryable conflict without mutating a starting member", async () => {
    mocks.getMemberByName.mockResolvedValueOnce({
      name: "worker",
      session_id: "child-1",
      status: "starting",
      plan_mode_required: true,
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
    expect(mocks.setMemberPlanApproved).not.toHaveBeenCalled();
    expect(mocks.injectTeamMessage).not.toHaveBeenCalled();
  });

  it("approves and notifies after membership is working", async () => {
    const response = (await POST(event() as never)) as Response;

    expect(response.status).toBe(200);
    expect(mocks.setMemberPlanApproved).toHaveBeenCalledWith("child-1");
    expect(mocks.injectTeamMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientSessionId: "child-1",
        fromName: "lead",
        kind: "teammate-message",
      }),
    );
  });
});

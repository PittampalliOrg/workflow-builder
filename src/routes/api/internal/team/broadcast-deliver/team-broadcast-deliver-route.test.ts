import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listMembers: vi.fn(),
  getMemberBySession: vi.fn(),
  injectTeamMessage: vi.fn(),
}));

vi.mock("$lib/server/teams/team-repo", () => ({
  listMembers: mocks.listMembers,
  getMemberBySession: mocks.getMemberBySession,
}));
vi.mock("$lib/server/teams/team-messaging", () => ({
  injectTeamMessage: mocks.injectTeamMessage,
}));

import { POST } from "./+server";

function event() {
  return {
    request: new Request(
      "http://workflow-builder/api/internal/team/broadcast-deliver",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          data: {
            teamId: "team-1",
            fromSessionId: "lead-1",
            content: "Team update",
            broadcastId: "broadcast-1",
          },
        }),
      },
    ),
  };
}

describe("team broadcast delivery route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getMemberBySession.mockResolvedValue({ name: "lead" });
    mocks.listMembers.mockResolvedValue([
      { name: "lead", session_id: "lead-1", status: "working" },
      { name: "ready", session_id: "ready-1", status: "working" },
      { name: "pending", session_id: "pending-1", status: "starting" },
    ]);
  });

  it("delivers to ready members and asks Dapr to retry a starting target", async () => {
    const response = (await POST(event() as never)) as Response;

    await expect(response.json()).resolves.toEqual({ status: "RETRY" });
    expect(mocks.injectTeamMessage).toHaveBeenCalledTimes(1);
    expect(mocks.injectTeamMessage).toHaveBeenCalledWith({
      recipientSessionId: "ready-1",
      fromName: "lead",
      content: "Team update",
      kind: "team-broadcast",
      sourceEventId: "team-broadcast:broadcast-1:ready-1",
    });
  });

  it("replays with deterministic ids and succeeds after promotion", async () => {
    mocks.listMembers.mockResolvedValueOnce([
      { name: "lead", session_id: "lead-1", status: "working" },
      { name: "ready", session_id: "ready-1", status: "working" },
      { name: "pending", session_id: "pending-1", status: "working" },
    ]);

    const response = (await POST(event() as never)) as Response;

    await expect(response.json()).resolves.toEqual({ status: "SUCCESS" });
    expect(mocks.injectTeamMessage).toHaveBeenCalledTimes(2);
    expect(mocks.injectTeamMessage).toHaveBeenNthCalledWith(1, {
      recipientSessionId: "ready-1",
      fromName: "lead",
      content: "Team update",
      kind: "team-broadcast",
      sourceEventId: "team-broadcast:broadcast-1:ready-1",
    });
    expect(mocks.injectTeamMessage).toHaveBeenNthCalledWith(2, {
      recipientSessionId: "pending-1",
      fromName: "lead",
      content: "Team update",
      kind: "team-broadcast",
      sourceEventId: "team-broadcast:broadcast-1:pending-1",
    });
  });
});

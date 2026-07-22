import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  shutdownMember: vi.fn(),
}));

vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    teamShutdown: { shutdownMember: mocks.shutdownMember },
  }),
}));
vi.mock("../../team-action-principal", () => ({
  authorizeTeamActionRequest: mocks.authorize,
}));

import { POST } from "./+server";

function event(name = "worker") {
  return {
    params: { teamId: "team-1" },
    request: new Request(
      "http://workflow-builder/api/internal/team/team-1/shutdown",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestedBySessionId: "lead-1", name }),
      },
    ),
  };
}

async function responseStatus(value: unknown): Promise<number> {
  try {
    return ((await value) as Response).status;
  } catch (cause) {
    return (cause as { status?: number }).status ?? 500;
  }
}

describe("team shutdown route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorize.mockResolvedValue({
      ok: true,
      principal: { sessionId: "lead-1" },
    });
    mocks.shutdownMember.mockResolvedValue({
      status: "confirmed",
      name: "worker",
      stop: { confirmed: true, state: "confirmed" },
    });
  });

  it("returns 200 only for a confirmed terminal shutdown", async () => {
    const response = (await POST(event() as never)) as Response;

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      state: "confirmed",
      name: "worker",
      stop: { confirmed: true, state: "confirmed" },
    });
    expect(mocks.shutdownMember).toHaveBeenCalledWith({
      teamId: "team-1",
      name: "worker",
    });
  });

  it("preserves an incomplete stop as retryable HTTP 202", async () => {
    mocks.shutdownMember.mockResolvedValueOnce({
      status: "stopping",
      name: "worker",
      stop: { confirmed: false, state: "stopping" },
    });

    const response = (await POST(event() as never)) as Response;

    expect(response.status).toBe(202);
    expect(response.headers.get("retry-after")).toBe("5");
    await expect(response.json()).resolves.toEqual({
      ok: false,
      state: "stopping",
      name: "worker",
      stop: { confirmed: false, state: "stopping" },
    });
  });

  it("returns consistent terminal evidence when a replay finds the session already purged", async () => {
    mocks.shutdownMember.mockResolvedValueOnce({
      status: "confirmed",
      name: "worker",
      terminalEvidence: "member_already_terminal",
    });

    const response = (await POST(event() as never)) as Response;

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      state: "confirmed",
      name: "worker",
      terminalEvidence: "member_already_terminal",
    });
  });

  it("maps missing durable state to non-success", async () => {
    mocks.shutdownMember.mockResolvedValueOnce({
      status: "not_found",
      message: "durable run for teammate 'worker' was not found",
    });

    expect(await responseStatus(POST(event() as never))).toBe(404);
  });

  it("maps stop-intent persistence failure to retryable HTTP 503", async () => {
    mocks.shutdownMember.mockResolvedValueOnce({
      status: "unavailable",
      message: "stop intent could not be persisted",
    });

    expect(await responseStatus(POST(event() as never))).toBe(503);
  });

  it("keeps lifecycle and persistence behind the application boundary", () => {
    const source = readFileSync(
      join(import.meta.dirname, "+server.ts"),
      "utf8",
    );
    expect(source).not.toContain("$lib/server/lifecycle");
    expect(source).not.toContain("$lib/server/teams/team-repo");
    expect(source).toContain("getApplicationAdapters().teamShutdown");
  });
});

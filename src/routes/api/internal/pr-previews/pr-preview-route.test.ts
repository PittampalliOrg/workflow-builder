import { beforeEach, describe, expect, it, vi } from "vitest";

const HEAD = "a".repeat(40);
const mocks = vi.hoisted(() => ({
  validatePreviewGovernanceDispatchToken: vi.fn(() => true),
  up: vi.fn(async () => ({
    prNumber: 42,
    alias: "pr-42",
    state: "provisioning",
  })),
  down: vi.fn(async () => ({ state: "down" })),
}));

vi.mock("$lib/server/internal-auth", () => ({
  validatePreviewGovernanceDispatchToken:
    mocks.validatePreviewGovernanceDispatchToken,
}));

vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    prPreviews: { up: mocks.up, down: mocks.down },
  }),
}));

vi.mock("$lib/server/application/config", () => ({
  getApplicationAdapterConfig: () => ({ prPreviewsEnabled: true }),
}));

import { POST } from "./+server";

function event(body: Record<string, unknown>) {
  return {
    request: new Request("http://bff/api/internal/pr-previews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  };
}

describe("PR preview command route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects requests without the purpose-specific governance credential", async () => {
    mocks.validatePreviewGovernanceDispatchToken.mockReturnValueOnce(false);
    const response = (await POST(
      event({ action: "up", prNumber: 42, headSha: HEAD }) as never,
    )) as Response;
    expect(response.status).toBe(401);
    expect(mocks.up).not.toHaveBeenCalled();
  });

  it("forwards only the PR number and observed exact head SHA", async () => {
    const response = (await POST(
      event({
        action: "up",
        prNumber: 42,
        headSha: HEAD,
        verify: true,
      }) as never,
    )) as Response;
    expect(response.status).toBe(202);
    expect(mocks.up).toHaveBeenCalledWith({
      prNumber: 42,
      headSha: HEAD,
      verify: true,
    });
  });

  it.each([
    "changedFiles",
    "headRef",
    "repository",
    "services",
    "platformRevision",
  ])("rejects caller authority field %s", async (field) => {
    const response = (await POST(
      event({
        action: "up",
        prNumber: 42,
        headSha: HEAD,
        [field]:
          field === "changedFiles" || field === "services"
            ? ["src/attacker.ts"]
            : "attacker/value",
      }) as never,
    )) as Response;
    expect(response.status).toBe(400);
    expect(mocks.up).not.toHaveBeenCalled();
  });

  it("keeps teardown keyed only by the server-owned PR alias", async () => {
    const response = (await POST(
      event({ action: "down", prNumber: 42 }) as never,
    )) as Response;
    expect(response.status).toBe(200);
    expect(mocks.down).toHaveBeenCalledWith({ prNumber: 42 });
  });
});

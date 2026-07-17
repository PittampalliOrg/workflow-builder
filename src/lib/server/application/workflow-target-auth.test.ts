import { describe, expect, it, vi } from "vitest";
import { ApplicationWorkflowTargetAuthService } from "./workflow-target-auth";

const identity = {
  userId: "user-1",
  email: "owner@example.com",
  platformId: "platform-1",
  projectId: "project-1",
  tokenVersion: 4,
};

function harness() {
  const identities = {
    resolveExecutionOwner: vi.fn(async () => identity),
  };
  const tokens = {
    issue: vi.fn(async () => "fresh-access-token"),
  };
  return {
    identities,
    tokens,
    service: new ApplicationWorkflowTargetAuthService({ identities, tokens }),
  };
}

describe("ApplicationWorkflowTargetAuthService", () => {
  it("issues from the authoritative execution owner", async () => {
    const h = harness();
    await expect(
      h.service.mintAccessToken({
        executionId: "execution-1",
        expectedUserId: "user-1",
        expectedProjectId: "project-1",
      }),
    ).resolves.toBe("fresh-access-token");
    expect(h.tokens.issue).toHaveBeenCalledWith(identity);
  });

  it.each([
    { expectedUserId: "user-2", expectedProjectId: "project-1" },
    { expectedUserId: "user-1", expectedProjectId: "project-2" },
    { expectedUserId: "user-1", expectedProjectId: null },
  ])("fails closed on a mismatched caller context", async (expected) => {
    const h = harness();
    await expect(
      h.service.mintAccessToken({ executionId: "execution-1", ...expected }),
    ).resolves.toBeNull();
    expect(h.tokens.issue).not.toHaveBeenCalled();
  });

  it("omits auth when the issuer is unavailable", async () => {
    const h = harness();
    h.tokens.issue.mockRejectedValueOnce(new Error("signing key unavailable"));
    await expect(
      h.service.mintAccessToken({
        executionId: "execution-1",
        expectedUserId: "user-1",
        expectedProjectId: "project-1",
      }),
    ).resolves.toBeNull();
  });
});

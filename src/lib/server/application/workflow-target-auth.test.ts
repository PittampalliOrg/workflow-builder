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
  const assertions = {
    issue: vi.fn(() => "purpose-assertion"),
    verify: vi.fn(
      (
        _assertion: string,
      ): { executionId: string; userId: string; projectId: string } | null => ({
        executionId: "execution-1",
        userId: "user-1",
        projectId: "project-1",
      }),
    ),
  };
  const cookies = {
    issue: vi.fn(async () => ({
      name: "wb_access_token" as const,
      value: "short-lived-owner-cookie",
      expiresAt: 301,
      httpOnly: true as const,
      secure: false,
      sameSite: "Strict" as const,
      path: "/" as const,
    })),
  };
  const origin = {
    getOrigin: vi.fn(
      () => "http://workflow-builder.workflow-builder.svc.cluster.local:3000",
    ),
  };
  return {
    identities,
    assertions,
    cookies,
    origin,
    service: new ApplicationWorkflowTargetAuthService({
      identities,
      assertions,
      cookies,
      origin,
    }),
  };
}

describe("ApplicationWorkflowTargetAuthService", () => {
  it("mints only a purpose assertion from authoritative execution ownership", async () => {
    const h = harness();
    await expect(
      h.service.mintAssertion({
        executionId: "execution-1",
        expectedUserId: "user-1",
        expectedProjectId: "project-1",
      }),
    ).resolves.toBe("purpose-assertion");
    expect(h.assertions.issue).toHaveBeenCalledWith({
      executionId: "execution-1",
      userId: "user-1",
      projectId: "project-1",
    });
    expect(h.cookies.issue).not.toHaveBeenCalled();
  });

  it.each([
    { expectedUserId: "user-2", expectedProjectId: "project-1" },
    { expectedUserId: "user-1", expectedProjectId: "project-2" },
    { expectedUserId: "user-1", expectedProjectId: null },
  ])("fails closed on a mismatched mint context", async (expected) => {
    const h = harness();
    await expect(
      h.service.mintAssertion({ executionId: "execution-1", ...expected }),
    ).resolves.toBeNull();
    expect(h.assertions.issue).not.toHaveBeenCalled();
  });

  it("exchanges just in time after verifying claims and current ownership", async () => {
    const h = harness();
    await expect(
      h.service.exchange({
        assertion: "purpose-assertion",
        executionId: "execution-1",
      }),
    ).resolves.toEqual({
      targetOrigin:
        "http://workflow-builder.workflow-builder.svc.cluster.local:3000",
      cookie: expect.objectContaining({
        name: "wb_access_token",
        httpOnly: true,
        secure: false,
        sameSite: "Strict",
      }),
    });
    expect(h.identities.resolveExecutionOwner).toHaveBeenCalledWith(
      "execution-1",
    );
    expect(h.cookies.issue).toHaveBeenCalledWith(identity, { secure: false });
  });

  it.each([
    {
      name: "execution mismatch",
      claims: {
        executionId: "execution-2",
        userId: "user-1",
        projectId: "project-1",
      },
    },
    {
      name: "user mismatch",
      claims: {
        executionId: "execution-1",
        userId: "user-2",
        projectId: "project-1",
      },
    },
    {
      name: "project mismatch",
      claims: {
        executionId: "execution-1",
        userId: "user-1",
        projectId: "project-2",
      },
    },
  ])("rejects exchange on $name", async ({ claims }) => {
    const h = harness();
    h.assertions.verify.mockReturnValueOnce(claims);
    await expect(
      h.service.exchange({
        assertion: "purpose-assertion",
        executionId: "execution-1",
      }),
    ).resolves.toBeNull();
    expect(h.cookies.issue).not.toHaveBeenCalled();
  });

  it("fails closed when assertion verification fails", async () => {
    const h = harness();
    h.assertions.verify.mockReturnValueOnce(null);
    await expect(
      h.service.exchange({
        assertion: "tampered",
        executionId: "execution-1",
      }),
    ).resolves.toBeNull();
    expect(h.identities.resolveExecutionOwner).not.toHaveBeenCalled();
    expect(h.cookies.issue).not.toHaveBeenCalled();
  });
});

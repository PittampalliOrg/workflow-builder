import { describe, expect, it, vi } from "vitest";
import type { WorkflowTargetAuthIdentity } from "$lib/server/application/ports";
import { ApplicationWorkflowTargetAuthService } from "./workflow-target-auth";

const identity: WorkflowTargetAuthIdentity = {
  userId: "user-1",
  email: "owner@example.com",
  platformId: "platform-1",
  projectId: "project-1",
  tokenVersion: 4,
  executionStatus: "running" as const,
  executionCompletedAt: null,
  executionStopRequestedAt: null,
  userStatus: "ACTIVE" as const,
  projectMembershipId: "membership-1",
};

function harness() {
  const identities = {
    resolveExecutionOwner: vi.fn(
      async (): Promise<WorkflowTargetAuthIdentity | null> => identity,
    ),
  };
  const assertions = {
    issue: vi.fn(() => "purpose-assertion"),
    verify: vi.fn(
      (
        _assertion: string,
      ): {
        executionId: string;
        userId: string;
        projectId: string;
        tokenVersion: number;
      } | null => ({
        executionId: "execution-1",
        userId: "user-1",
        projectId: "project-1",
        tokenVersion: 4,
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
      tokenVersion: 4,
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

  it("does not mint an assertion for a terminal execution", async () => {
    const h = harness();
    h.identities.resolveExecutionOwner.mockResolvedValueOnce({
      ...identity,
      executionStatus: "success",
      executionCompletedAt: new Date("2026-07-20T20:00:00.000Z"),
    });
    await expect(
      h.service.mintAssertion({
        executionId: "execution-1",
        expectedUserId: "user-1",
        expectedProjectId: "project-1",
      }),
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

  it("revalidates current authorization without issuing a credential", async () => {
    const h = harness();
    await expect(
      h.service.validate({
        assertion: "purpose-assertion",
        executionId: "execution-1",
      }),
    ).resolves.toBe(true);
    expect(h.identities.resolveExecutionOwner).toHaveBeenCalledWith(
      "execution-1",
    );
    expect(h.cookies.issue).not.toHaveBeenCalled();
    expect(h.origin.getOrigin).not.toHaveBeenCalled();
  });

  it("fails revalidation after assertion expiry or identity revocation", async () => {
    const expired = harness();
    expired.assertions.verify.mockReturnValueOnce(null);
    await expect(
      expired.service.validate({
        assertion: "expired-purpose-assertion",
        executionId: "execution-1",
      }),
    ).resolves.toBe(false);
    expect(expired.identities.resolveExecutionOwner).not.toHaveBeenCalled();

    const revoked = harness();
    revoked.identities.resolveExecutionOwner.mockResolvedValueOnce({
      ...identity,
      projectMembershipId: null,
    });
    await expect(
      revoked.service.validate({
        assertion: "purpose-assertion",
        executionId: "execution-1",
      }),
    ).resolves.toBe(false);
    expect(revoked.cookies.issue).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "execution mismatch",
      claims: {
        executionId: "execution-2",
        userId: "user-1",
        projectId: "project-1",
        tokenVersion: 4,
      },
    },
    {
      name: "user mismatch",
      claims: {
        executionId: "execution-1",
        userId: "user-2",
        projectId: "project-1",
        tokenVersion: 4,
      },
    },
    {
      name: "project mismatch",
      claims: {
        executionId: "execution-1",
        userId: "user-1",
        projectId: "project-2",
        tokenVersion: 4,
      },
    },
    {
      name: "revoked token version",
      claims: {
        executionId: "execution-1",
        userId: "user-1",
        projectId: "project-1",
        tokenVersion: 3,
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

  it.each([
    {
      name: "pending execution",
      identity: { ...identity, executionStatus: "pending" as const },
    },
    {
      name: "terminal execution",
      identity: {
        ...identity,
        executionStatus: "success" as const,
        executionCompletedAt: new Date("2026-07-20T20:00:00.000Z"),
      },
    },
    {
      name: "stop-requested execution",
      identity: {
        ...identity,
        executionStopRequestedAt: new Date("2026-07-20T20:00:00.000Z"),
      },
    },
    {
      name: "inactive user",
      identity: { ...identity, userStatus: "INACTIVE" as const },
    },
    {
      name: "revoked project membership",
      identity: { ...identity, projectMembershipId: null },
    },
  ])(
    "rejects an exchange for a $name",
    async ({ identity: deniedIdentity }) => {
      const h = harness();
      h.identities.resolveExecutionOwner.mockResolvedValueOnce(deniedIdentity);
      await expect(
        h.service.exchange({
          assertion: "purpose-assertion",
          executionId: "execution-1",
        }),
      ).resolves.toBeNull();
      expect(h.cookies.issue).not.toHaveBeenCalled();
    },
  );
});

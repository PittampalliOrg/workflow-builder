import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  EnvironmentWorkflowTargetAuthOriginProvider,
  HmacWorkflowTargetAuthAssertionAdapter,
  JwtWorkflowTargetAuthCookieIssuer,
  PostgresWorkflowTargetAuthIdentityRepository,
} from "./workflow-target-auth";

const now = new Date("2026-07-20T20:00:00.000Z");
const secret = "test-browser-target-auth-secret-that-is-long-enough";

const activeOwnerRow = {
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

function identityRepository(row: Record<string, unknown> | null) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["from", "innerJoin", "leftJoin", "where"]) {
    query[method] = vi.fn(() => query);
  }
  query.limit = vi.fn(async () => (row ? [row] : []));
  const database = { select: vi.fn(() => query) };
  return {
    database,
    query,
    repository: new PostgresWorkflowTargetAuthIdentityRepository(
      database as never,
    ),
  };
}

describe("HmacWorkflowTargetAuthAssertionAdapter", () => {
  it("round-trips execution, user, and project claims", () => {
    const adapter = new HmacWorkflowTargetAuthAssertionAdapter({
      secret: () => secret,
      now: () => now,
      ttlSeconds: 300,
    });

    const assertion = adapter.issue({
      executionId: "execution-1",
      userId: "user-1",
      projectId: "project-1",
      tokenVersion: 4,
    });
    expect(assertion).toMatch(/^wfb_browser_auth_v1\./);
    expect(adapter.verify(assertion)).toEqual({
      executionId: "execution-1",
      userId: "user-1",
      projectId: "project-1",
      tokenVersion: 4,
    });
    const [prefix, encoded, signature] = assertion.split(".");
    const directRootSignature = createHmac("sha256", secret)
      .update(`${prefix}.${encoded}`, "utf8")
      .digest("base64url");
    expect(signature).not.toBe(directRootSignature);
  });

  it("keeps the purpose grant valid for a bounded one-hour K3 think window", () => {
    const adapter = new HmacWorkflowTargetAuthAssertionAdapter({
      secret: () => secret,
      now: () => now,
    });
    const assertion = adapter.issue({
      executionId: "execution-1",
      userId: "user-1",
      projectId: "project-1",
      tokenVersion: 4,
    });
    const payload = JSON.parse(
      Buffer.from(assertion.split(".")[1], "base64url").toString("utf8"),
    ) as { iat: number; exp: number; aud: string; purpose: string };
    expect(payload.exp - payload.iat).toBe(60 * 60);
    expect(payload.aud).toBe("workflow-builder-browser-target-auth");
    expect(payload.purpose).toBe("browser-target-auth");
  });

  it("rejects tampering and expiry", () => {
    let current = now;
    const adapter = new HmacWorkflowTargetAuthAssertionAdapter({
      secret: () => secret,
      now: () => current,
      ttlSeconds: 60,
    });
    const assertion = adapter.issue({
      executionId: "execution-1",
      userId: "user-1",
      projectId: "project-1",
      tokenVersion: 4,
    });
    const [prefix, payload, signature] = assertion.split(".");
    expect(adapter.verify(`${prefix}.${payload}.${signature}x`)).toBeNull();
    current = new Date(now.getTime() + 61_000);
    expect(adapter.verify(assertion)).toBeNull();
  });
});

describe("PostgresWorkflowTargetAuthIdentityRepository", () => {
  it("returns only an active owner with current project membership", async () => {
    const { repository, database, query } = identityRepository(activeOwnerRow);
    await expect(
      repository.resolveExecutionOwner("execution-1"),
    ).resolves.toEqual(activeOwnerRow);
    expect(database.select).toHaveBeenCalled();
    expect(query.innerJoin).toHaveBeenCalledTimes(4);
    expect(query.where).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "pending run",
      row: { ...activeOwnerRow, executionStatus: "pending" },
    },
    {
      name: "terminal run",
      row: {
        ...activeOwnerRow,
        executionStatus: "success",
        executionCompletedAt: now,
      },
    },
    {
      name: "inactive user",
      row: { ...activeOwnerRow, userStatus: "INACTIVE" },
    },
    {
      name: "revoked membership",
      row: { ...activeOwnerRow, projectMembershipId: null },
    },
  ])("rejects a $name", async ({ row }) => {
    await expect(
      identityRepository(row).repository.resolveExecutionOwner("execution-1"),
    ).resolves.toBeNull();
  });
});

describe("JwtWorkflowTargetAuthCookieIssuer", () => {
  it("returns a bounded HttpOnly host cookie without refresh capability", async () => {
    const generate = vi.fn(async () => "short-lived-access-token");
    const issuer = new JwtWorkflowTargetAuthCookieIssuer({
      now: () => now,
      generate,
    });
    await expect(
      issuer.issue(
        {
          userId: "user-1",
          email: "owner@example.com",
          platformId: "platform-1",
          projectId: "project-1",
          tokenVersion: 4,
          executionStatus: "running",
          executionCompletedAt: null,
          executionStopRequestedAt: null,
          userStatus: "ACTIVE",
          projectMembershipId: "membership-1",
        },
        { secure: true },
      ),
    ).resolves.toEqual({
      name: "wb_access_token",
      value: "short-lived-access-token",
      expiresAt: Math.floor(now.getTime() / 1_000) + 30 * 60,
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      path: "/",
    });
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "user-1", projectId: "project-1" }),
      `${30 * 60}s`,
    );
  });
});

describe("EnvironmentWorkflowTargetAuthOriginProvider", () => {
  it("normalizes only an exact HTTP(S) origin", () => {
    expect(
      new EnvironmentWorkflowTargetAuthOriginProvider(
        () => "https://workflow-builder.example.test:8443/",
      ).getOrigin(),
    ).toBe("https://workflow-builder.example.test:8443");
  });

  it.each([
    "javascript:alert(1)",
    "https://user:pass@example.test",
    "https://example.test/path",
    "https://example.test?next=evil",
  ])("rejects non-origin configuration %s", (value) => {
    expect(() =>
      new EnvironmentWorkflowTargetAuthOriginProvider(() => value).getOrigin(),
    ).toThrow("browser target origin must be an HTTP(S) origin");
  });
});

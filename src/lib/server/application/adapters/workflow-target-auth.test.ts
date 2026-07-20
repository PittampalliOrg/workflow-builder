import { describe, expect, it, vi } from "vitest";
import {
  EnvironmentWorkflowTargetAuthOriginProvider,
  HmacWorkflowTargetAuthAssertionAdapter,
  JwtWorkflowTargetAuthCookieIssuer,
} from "./workflow-target-auth";

const now = new Date("2026-07-20T20:00:00.000Z");
const secret = "test-browser-target-auth-secret-that-is-long-enough";

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
    });
    expect(assertion).toMatch(/^wfb_browser_auth_v1\./);
    expect(adapter.verify(assertion)).toEqual({
      executionId: "execution-1",
      userId: "user-1",
      projectId: "project-1",
    });
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
    });
    const [prefix, payload, signature] = assertion.split(".");
    expect(adapter.verify(`${prefix}.${payload}.${signature}x`)).toBeNull();
    current = new Date(now.getTime() + 61_000);
    expect(adapter.verify(assertion)).toBeNull();
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

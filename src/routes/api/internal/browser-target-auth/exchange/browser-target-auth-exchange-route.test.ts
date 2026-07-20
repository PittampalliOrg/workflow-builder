import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  validateInternalToken: vi.fn(() => true),
  exchange: vi.fn(),
}));

vi.mock("$lib/server/internal-auth", () => ({
  validateInternalToken: mocks.validateInternalToken,
}));

vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    workflowTargetAuth: { exchange: mocks.exchange },
  }),
}));

import { POST } from "./+server";

function request(body: unknown): Request {
  return new Request(
    "http://workflow-builder/api/internal/browser-target-auth/exchange",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Token": "internal-token",
      },
      body: JSON.stringify(body),
    },
  );
}

describe("POST /api/internal/browser-target-auth/exchange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateInternalToken.mockReturnValue(true);
    mocks.exchange.mockResolvedValue({
      targetOrigin:
        "http://workflow-builder.workflow-builder.svc.cluster.local:3000",
      cookie: {
        name: "wb_access_token",
        value: "short-lived-owner-cookie",
        expiresAt: 1234,
        httpOnly: true,
        secure: false,
        sameSite: "Strict",
        path: "/",
      },
    });
  });

  it("requires service authentication", async () => {
    mocks.validateInternalToken.mockReturnValueOnce(false);
    const response = await POST({ request: request({}) } as never);
    expect(response.status).toBe(401);
    expect(mocks.exchange).not.toHaveBeenCalled();
  });

  it("passes only assertion and execution identity to the application port", async () => {
    const response = await POST({
      request: request({
        targetAuthAssertion: "purpose-assertion",
        executionId: "execution-1",
        targetOrigin: "https://attacker.example",
        cookieName: "attacker_cookie",
      }),
    } as never);
    expect(response.status).toBe(200);
    expect(mocks.exchange).toHaveBeenCalledWith({
      assertion: "purpose-assertion",
      executionId: "execution-1",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(
      expect.objectContaining({
        targetOrigin:
          "http://workflow-builder.workflow-builder.svc.cluster.local:3000",
        cookie: expect.objectContaining({ httpOnly: true }),
      }),
    );
  });

  it("fails closed for invalid assertions", async () => {
    mocks.exchange.mockResolvedValueOnce(null);
    const response = await POST({
      request: request({
        targetAuthAssertion: "tampered",
        executionId: "execution-1",
      }),
    } as never);
    expect(response.status).toBe(403);
  });
});

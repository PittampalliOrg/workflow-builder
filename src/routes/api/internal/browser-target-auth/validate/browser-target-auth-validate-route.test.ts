import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  validateInternalToken: vi.fn(() => true),
  validate: vi.fn(async () => true),
}));

vi.mock("$lib/server/internal-auth", () => ({
  validateInternalToken: mocks.validateInternalToken,
}));

vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    workflowTargetAuth: { validate: mocks.validate },
  }),
}));

import { POST } from "./+server";

function request(body: unknown): Request {
  return new Request(
    "http://workflow-builder/api/internal/browser-target-auth/validate",
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

describe("POST /api/internal/browser-target-auth/validate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateInternalToken.mockReturnValue(true);
    mocks.validate.mockResolvedValue(true);
  });

  it("requires service authentication", async () => {
    mocks.validateInternalToken.mockReturnValueOnce(false);
    const response = await POST({ request: request({}) } as never);
    expect(response.status).toBe(401);
    expect(mocks.validate).not.toHaveBeenCalled();
  });

  it("revalidates only the exact assertion and execution without a credential", async () => {
    const response = await POST({
      request: request({
        targetAuthAssertion: "purpose-assertion",
        executionId: "execution-1",
        targetOrigin: "https://attacker.example",
      }),
    } as never);
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
    expect(mocks.validate).toHaveBeenCalledWith({
      assertion: "purpose-assertion",
      executionId: "execution-1",
    });
  });

  it.each(["terminal", "revoked", "expired"])(
    "fails closed when authorization becomes %s after initialization",
    async () => {
      mocks.validate.mockResolvedValueOnce(false);
      const response = await POST({
        request: request({
          targetAuthAssertion: "purpose-assertion",
          executionId: "execution-1",
        }),
      } as never);
      expect(response.status).toBe(403);
    },
  );
});

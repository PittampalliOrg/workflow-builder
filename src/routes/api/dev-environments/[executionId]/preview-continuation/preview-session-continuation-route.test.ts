import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  continue: vi.fn(),
}));

vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    previewSessionContinuation: { continue: mocks.continue },
  }),
}));

import { POST } from "./+server";

function event(overrides: Record<string, unknown> = {}) {
  return {
    params: { executionId: "execution-1" },
    request: new Request(
      "http://localhost/api/dev-environments/execution-1/preview-continuation",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "capture",
          services: ["workflow-builder"],
        }),
      },
    ),
    locals: { session: { userId: "admin-1", projectId: "project-1" } },
    ...overrides,
  } as never;
}

async function expectStatus(promise: Promise<unknown>, status: number) {
  try {
    const response = await promise;
    expect((response as Response).status).toBe(status);
  } catch (cause) {
    expect((cause as { status?: number }).status).toBe(status);
  }
}

describe("preview session continuation route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.continue.mockResolvedValue({
      status: "ok",
      httpStatus: 200,
      body: {
        action: "capture",
        ok: true,
        artifactId: "artifact-1",
        services: [{ service: "workflow-builder", ok: true }],
      },
    });
  });

  it("delegates the authenticated actor, active project, and raw action to the application port", async () => {
    const response = (await POST(event())) as Response;

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      action: "capture",
      ok: true,
      artifactId: "artifact-1",
      services: [{ service: "workflow-builder", ok: true }],
    });
    expect(mocks.continue).toHaveBeenCalledWith({
      executionId: "execution-1",
      userId: "admin-1",
      projectId: "project-1",
      action: { action: "capture", services: ["workflow-builder"] },
    });
  });

  it("requires an authenticated user before it reaches the continuation port", async () => {
    await expectStatus(
      Promise.resolve(POST(event({ locals: { session: null } }))),
      401,
    );
    expect(mocks.continue).not.toHaveBeenCalled();
  });

  it("preserves application authorization failures", async () => {
    mocks.continue.mockResolvedValueOnce({
      status: "error",
      httpStatus: 403,
      message: "Admin access required",
    });

    await expectStatus(Promise.resolve(POST(event())), 403);
  });

  it("keeps the public route free of direct preview-control and internal-route calls", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
      "utf8",
    );

    expect(source).toContain("previewSessionContinuation.continue");
    expect(source).not.toContain("previewSourcePromotion");
    expect(source).not.toContain("previewAcceptanceBroker");
    expect(source).not.toContain("devPreviewSourceCapture");
    expect(source).not.toContain("/api/internal/");
    expect(source).not.toContain("$lib/server/application/adapters");
    expect(source).not.toContain("$lib/server/db");
    expect(source).not.toContain("function-router");
  });
});

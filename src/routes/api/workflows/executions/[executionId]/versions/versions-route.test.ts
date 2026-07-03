import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const workflowCodeVersions = {
    listVersions: vi.fn(
      async (): Promise<unknown> => ({
        status: "ok" as const,
        body: {
          versions: [
            {
              artifactId: "artifact-source",
              executionId: "exec-1",
              nodeId: "agent",
              fileId: "file-1",
              sizeBytes: 123,
              title: "Source bundle",
              payload: { tier: "full", base: "main" },
              promotion: null,
              createdAt: "2026-01-01T00:00:00.000Z",
              promotionGate: { allowed: true, reason: "not_required" },
            },
          ],
          outstanding: true,
        },
      }),
    ),
  };
  return { workflowCodeVersions };
});

vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    workflowCodeVersions: mocks.workflowCodeVersions,
  }),
}));

import { GET } from "./+server";

function event(overrides: Record<string, unknown> = {}) {
  return {
    params: { executionId: "exec-1" },
    locals: { session: { userId: "user-1", projectId: "project-1" } },
    ...overrides,
  };
}

async function expectHttpStatus(promise: Promise<unknown>, status: number) {
  try {
    const result = await promise;
    expect((result as { status?: number }).status).toBe(status);
  } catch (err) {
    expect((err as { status?: number }).status).toBe(status);
  }
}

describe("workflow execution versions route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the route behind workflow-data application services", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
      "utf8",
    );
    expect(source).toContain("getApplicationAdapters");
    expect(source).toContain("workflowCodeVersions");
    expect(source).not.toContain("$lib/server/db");
    expect(source).not.toContain("drizzle-orm");
    expect(source).not.toContain("workflowData");
    expect(source).not.toContain("assertInScope");
    expect(source).not.toContain("SOURCE_BUNDLE_KIND");
    expect(source).not.toContain("evaluatePromotionGate");
  });

  it("returns source-bundle versions and outstanding promotion state", async () => {
    const response = (await GET(event() as never)) as Response;

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      versions: [
        {
          artifactId: "artifact-source",
          executionId: "exec-1",
          nodeId: "agent",
          fileId: "file-1",
          sizeBytes: 123,
          title: "Source bundle",
          payload: { tier: "full", base: "main" },
          promotion: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          promotionGate: { allowed: true, reason: "not_required" },
        },
      ],
      outstanding: true,
    });
    expect(mocks.workflowCodeVersions.listVersions).toHaveBeenCalledWith({
      executionId: "exec-1",
      userId: "user-1",
      projectId: "project-1",
    });
  });

  it("maps application-service not-found responses", async () => {
    mocks.workflowCodeVersions.listVersions.mockResolvedValueOnce({
      status: "error",
      httpStatus: 404,
      message: "Execution not found",
    });

    await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
  });
});

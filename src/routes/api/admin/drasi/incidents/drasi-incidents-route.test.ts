import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isPlatformAdmin: vi.fn(async () => true),
  listByWorkflowId: vi.fn(async () => [
    {
      id: "evt-incident-1",
      workflowId: "platform-incident-analysis",
      status: "success",
      daprInstanceId: "evt-incident-1",
      startedAt: new Date("2026-07-21T12:01:00Z"),
      completedAt: new Date("2026-07-21T12:02:00Z"),
      duration: "60000",
      input: {
        source: "drasi",
        queryId: "dapr-resource-warning",
        severity: "warning",
        subject: "Dapr component warning",
        dedupKey: "drasi:dapr-resource-warning:dev:5815f3f934a249c080b23832",
        episodeStartedAt: "2026-07-21T12:00:00Z",
        resourceName: "workflowstatestore",
        evidence: { reason: "Warning condition observed" },
      },
      output: null,
    },
  ]),
}));

vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    workflowData: { isPlatformAdmin: mocks.isPlatformAdmin },
    workflowExecutions: { listByWorkflowId: mocks.listByWorkflowId },
  }),
}));

import { GET } from "./+server";

function event(userId: string | null, limit = "100") {
  return {
    locals: userId ? { session: { userId } } : {},
    url: new URL(`http://localhost/api/admin/drasi/incidents?limit=${limit}`),
  };
}

describe("Drasi incident read route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isPlatformAdmin.mockResolvedValue(true);
  });

  it("requires authentication and platform-admin authorization", async () => {
    await expect(GET(event(null) as never)).rejects.toMatchObject({
      status: 401,
    });

    mocks.isPlatformAdmin.mockResolvedValueOnce(false);
    await expect(GET(event("member-1") as never)).rejects.toMatchObject({
      status: 403,
    });
    expect(mocks.listByWorkflowId).not.toHaveBeenCalled();
  });

  it("returns the fixed, bounded platform incident feed", async () => {
    const response = (await GET(event("admin-1", "9999") as never)) as Response;
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.listByWorkflowId).toHaveBeenCalledWith({
      workflowId: "platform-incident-analysis",
      limit: 200,
      include: "full",
    });
    await expect(response.json()).resolves.toMatchObject({
      incidents: [
        {
          id: "evt-incident-1",
          queryId: "dapr-resource-warning",
          title: "Dapr component warning",
        },
      ],
      truncated: false,
    });
  });
});

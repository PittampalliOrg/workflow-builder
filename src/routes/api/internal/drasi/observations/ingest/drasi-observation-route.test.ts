import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ingest: vi.fn(async (event: Record<string, unknown>) => ({
    eventId: event.eventId,
  })),
  validateToken: vi.fn(() => true),
}));

vi.mock("$lib/server/internal-auth", () => ({
  validateDrasiIncidentIngestToken: mocks.validateToken,
}));
vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    gitOpsActivityEvents: { ingest: mocks.ingest },
  }),
}));

import { POST } from "./+server";

const observation = {
  resourceRef: {
    group: "agents.x-k8s.io",
    version: "v1beta1",
    resource: "sandboxes",
    kind: "Sandbox",
    namespace: "workflow-builder",
    name: "sandbox-1",
    uid: "uid-1",
  },
  phase: "Pending",
  reason: "AwaitingReadyCondition",
  message: "Sandbox is not ready",
  observedAt: "2026-07-21T12:00:00Z",
  correlation: { cluster: "dev", resourceVersion: "123" },
};

function event(body: unknown) {
  return {
    request: new Request(
      "http://localhost/api/internal/drasi/observations/ingest",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  };
}

describe("Drasi observation ingest route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateToken.mockReturnValue(true);
  });

  it("persists the server-normalized projection", async () => {
    const response = (await POST(event(observation) as never)) as Response;
    expect(response.status).toBe(202);
    expect(mocks.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "drasi-kubernetes-observer-current",
        raw: {},
      }),
    );
    expect(mocks.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "drasi-kubernetes-observer",
        raw: {},
      }),
    );
    expect(mocks.ingest).toHaveBeenCalledTimes(2);
  });

  it("rejects unauthorized and raw resource bodies", async () => {
    mocks.validateToken.mockReturnValueOnce(false);
    expect((await POST(event(observation) as never) as Response).status).toBe(401);
    expect(
      (await POST(event({ ...observation, raw: { env: [] } }) as never) as Response)
        .status,
    ).toBe(400);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });
});

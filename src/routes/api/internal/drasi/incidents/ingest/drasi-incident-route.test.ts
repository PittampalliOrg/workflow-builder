import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  publish: vi.fn(async () => undefined),
  validateToken: vi.fn(() => true),
}));

vi.mock("$env/dynamic/private", () => ({ env: { CLUSTER_NAME: "dev" } }));
vi.mock("$lib/server/internal-auth", () => ({
  validateDrasiIncidentIngestToken: mocks.validateToken,
}));
vi.mock("$lib/server/application/event-bus", () => ({
  getEventBusAdapter: () => ({ publish: mocks.publish }),
}));

import { POST } from "./+server";

function event(body: unknown) {
  return {
    request: new Request("http://localhost/api/internal/drasi/incidents/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  };
}

const incident = {
  queryId: "sandbox-provisioning-stalled",
  episodeStartedAt: "2026-07-21T12:00:00Z",
  severity: "warning",
  resourceKind: "Sandbox",
  resourceNamespace: "workflow-builder",
  resourceName: "sandbox-1",
  evidence: { reason: "Ready condition remained false" },
};

describe("Drasi incident ingest route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateToken.mockReturnValue(true);
    mocks.publish.mockResolvedValue(undefined);
  });

  it("publishes only the fixed incident workflow envelope", async () => {
    const response = (await POST(event(incident) as never)) as Response;
    expect(response.status).toBe(202);
    expect(mocks.publish).toHaveBeenCalledWith(
      "workflow.triggers",
      expect.objectContaining({
        workflowId: "platform-incident-analysis",
        triggerId: "drasi:sandbox-provisioning-stalled",
        triggerData: expect.objectContaining({
          source: "drasi",
          cluster: "dev",
          resourceName: "sandbox-1",
        }),
      }),
    );
  });

  it("rejects unauthorized, unknown, and caller-selected workflows", async () => {
    mocks.validateToken.mockReturnValueOnce(false);
    expect((await POST(event(incident) as never) as Response).status).toBe(401);

    expect(
      (await POST(event({ ...incident, queryId: "arbitrary" }) as never) as Response)
        .status,
    ).toBe(400);
    expect(
      (await POST(event({ ...incident, workflowName: "attacker" }) as never) as Response)
        .status,
    ).toBe(400);
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("returns 502 when the canonical bus is unavailable", async () => {
    mocks.publish.mockRejectedValueOnce(new Error("nats unavailable"));
    const response = (await POST(event(incident) as never)) as Response;
    expect(response.status).toBe(502);
  });
});

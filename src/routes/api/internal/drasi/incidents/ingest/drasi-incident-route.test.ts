import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  publish: vi.fn(async () => undefined),
  validateInternalToken: vi.fn(() => true),
}));

vi.mock("$env/dynamic/private", () => ({
  env: {
    CLUSTER_NAME: "dev",
    DRASI_INCIDENT_WORKFLOW_NAME: "platform-incident-analysis",
  },
}));
vi.mock("$lib/server/internal-auth", () => ({
  validateInternalToken: mocks.validateInternalToken,
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
  incidentKey: "workflow-builder/sandbox-1",
  episodeStartedAt: "2026-07-21T12:00:00Z",
  severity: "warning",
  evidence: { reason: "Ready condition remained false" },
};

describe("Drasi incident ingest route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateInternalToken.mockReturnValue(true);
    mocks.publish.mockResolvedValue(undefined);
  });

  it("publishes only the server-mapped incident workflow envelope", async () => {
    const response = (await POST(event({ ...incident, workflowName: "attacker" }) as never)) as Response;

    expect(response.status).toBe(202);
    expect(mocks.publish).toHaveBeenCalledWith(
      "workflow.triggers",
      expect.objectContaining({
        workflowName: "platform-incident-analysis",
        triggerId: "drasi:sandbox-provisioning-stalled",
        triggerData: expect.objectContaining({
          source: "drasi",
          cluster: "dev",
          incidentType: "sandbox-provisioning-stalled",
        }),
      }),
    );
  });

  it("rejects unauthorized and unknown queries", async () => {
    mocks.validateInternalToken.mockReturnValueOnce(false);
    const unauthorized = (await POST(event(incident) as never)) as Response;
    expect(unauthorized.status).toBe(401);

    const unknown = (await POST(
      event({ ...incident, queryId: "arbitrary" }) as never,
    )) as Response;
    expect(unknown.status).toBe(400);
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("returns 502 when the canonical bus is unavailable", async () => {
    mocks.publish.mockRejectedValueOnce(new Error("nats unavailable"));
    const response = (await POST(event(incident) as never)) as Response;
    expect(response.status).toBe(502);
  });
});

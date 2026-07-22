import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionDetail: vi.fn(),
  daprFetch: vi.fn(),
  resolveSessionRuntimeTarget: vi.fn(),
}));

vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    workflowData: { getSessionDetail: mocks.getSessionDetail },
  }),
}));
vi.mock("$lib/server/dapr-client", () => ({
  daprFetch: (...args: unknown[]) => mocks.daprFetch(...args),
}));
vi.mock("$lib/server/sessions/runtime-target", () => ({
  resolveSessionRuntimeTarget: (...args: unknown[]) =>
    mocks.resolveSessionRuntimeTarget(...args),
  runtimeUsesSharedWorkspace: vi.fn(() => false),
}));

import { raiseSessionUserEvents } from "$lib/server/sessions/spawn";

const delivery = {
  kind: "team-mailbox" as const,
  batchId: "team-mailbox-batch-1",
  eventIds: ["event-1"],
};

describe("team mailbox runtime receipt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionDetail.mockResolvedValue({
      daprInstanceId: "session-1",
    });
    mocks.resolveSessionRuntimeTarget.mockResolvedValue({
      appId: "dapr-agent-py",
      invokeTarget: "dapr-agent-py",
      runtimeSandboxName: null,
    });
  });

  it("rejects a non-receipting HTTP 200", async () => {
    mocks.daprFetch.mockResolvedValueOnce(Response.json({ ok: true }));

    await expect(
      raiseSessionUserEvents("session-1", [], delivery),
    ).rejects.toThrow(
      "Runtime did not acknowledge mailbox delivery team-mailbox-batch-1",
    );
  });

  it.each(["dapr-agent-py", "pydantic-ai-agent-py"])(
    "accepts only the exact durable delivery receipt from %s",
    async (runtimeAppId) => {
      mocks.resolveSessionRuntimeTarget.mockResolvedValueOnce({
        appId: runtimeAppId,
        invokeTarget: runtimeAppId,
        runtimeSandboxName: null,
      });
      mocks.daprFetch.mockResolvedValueOnce(
        Response.json({
          ok: true,
          accepted: true,
          deliveryId: delivery.batchId,
        }),
      );

      await expect(
        raiseSessionUserEvents("session-1", [], delivery),
      ).resolves.toEqual({
        accepted: true,
        deliveryId: delivery.batchId,
      });
      expect(mocks.daprFetch.mock.calls[0]?.[0]).toContain(
        `/invoke/${runtimeAppId}/method/internal/sessions/raise-event`,
      );
    },
  );
});

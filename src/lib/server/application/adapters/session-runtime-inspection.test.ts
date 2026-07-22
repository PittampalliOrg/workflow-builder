import { describe, expect, it, vi } from "vitest";
import { DURABLE_RUNTIME_MISSING_STATUS } from "$lib/server/lifecycle/cascade";
import { DaprSessionRuntimeInspectionAdapter } from "./lifecycle-cascade";

const TARGET = {
  runtimeAppId: "agent-runtime-shared-pool",
  instanceId: "session-runtime-generation-1",
  runtimeSandboxName: null,
};

describe("DaprSessionRuntimeInspectionAdapter", () => {
  it.each([
    [DURABLE_RUNTIME_MISSING_STATUS, "not_found"],
    ["RUNNING", "active"],
    ["COMPLETED", "terminal"],
    [null, "unknown"],
  ] as const)("classifies %o as %s", async (status, expected) => {
    const getAgentRuntimeStatus = vi.fn(async () => status);
    const adapter = new DaprSessionRuntimeInspectionAdapter({
      getAgentRuntimeStatus,
    });

    await expect(adapter.inspectRuntimeInstance(TARGET)).resolves.toBe(expected);
    expect(getAgentRuntimeStatus).toHaveBeenCalledWith(
      TARGET.runtimeAppId,
      TARGET.instanceId,
      null,
    );
  });

  it("fails closed to unknown on adapter errors", async () => {
    const adapter = new DaprSessionRuntimeInspectionAdapter({
      getAgentRuntimeStatus: vi.fn(async () => {
        throw new Error("placement unavailable");
      }),
    });
    await expect(adapter.inspectRuntimeInstance(TARGET)).resolves.toBe(
      "unknown",
    );
  });
});

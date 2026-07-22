import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activateAgentWorkflowHostGeneration: vi.fn(async () => undefined),
  isAgentWorkflowHostAbsentError: vi.fn(() => false),
  probeAgentWorkflowHostAppReady: vi.fn(),
  recreateAgentWorkflowHostGeneration: vi.fn(async () => undefined),
}));

vi.mock("$lib/server/sessions/agent-workflow-host", () => mocks);

import { AgentWorkflowHostRecoveryProviderAdapter } from "./session-runtime-host-recovery";

describe("AgentWorkflowHostRecoveryProviderAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports ready only when the exact runtime app health probe succeeds", async () => {
    mocks.probeAgentWorkflowHostAppReady.mockResolvedValueOnce({
      ok: true,
      attempts: 1,
      status: 200,
      baseUrl: "http://10.0.0.42:8002",
      podName: "agent-host-ready",
      podIP: "10.0.0.42",
    });
    const adapter = new AgentWorkflowHostRecoveryProviderAdapter();

    await expect(
      adapter.probeReadiness({
        runtimeAppId: "agent-session-ready",
        runtimeSandboxName: "agent-host-agent-session-ready",
      }),
    ).resolves.toBe("ready");

    expect(mocks.probeAgentWorkflowHostAppReady).toHaveBeenCalledWith({
      agentAppId: "agent-session-ready",
    });
  });

  it("keeps an activated runtime retryable when its health probe is not ready", async () => {
    mocks.probeAgentWorkflowHostAppReady.mockResolvedValueOnce(null);
    const adapter = new AgentWorkflowHostRecoveryProviderAdapter();

    await expect(
      adapter.probeReadiness({
        runtimeAppId: "agent-session-cold",
        runtimeSandboxName: "agent-host-agent-session-cold",
      }),
    ).resolves.toBe("not_ready");
  });
});

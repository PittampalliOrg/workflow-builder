import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  maybeProvisionAgentWorkflowHost: vi.fn(),
  resolveWorkflowGithubToken: vi.fn(),
}));

vi.mock("$env/dynamic/private", () => ({ env: process.env }));
vi.mock("$lib/server/sessions/agent-workflow-host", () => ({
  maybeProvisionAgentWorkflowHost: mocks.maybeProvisionAgentWorkflowHost,
}));
vi.mock("$lib/server/workflows/github-token", () => ({
  resolveWorkflowGithubToken: mocks.resolveWorkflowGithubToken,
}));

import { provisionWorkspaceHelperPod } from "./helper-pod";

describe("workspace helper provisioning boundary", () => {
  beforeEach(() => {
    mocks.maybeProvisionAgentWorkflowHost.mockReset();
    mocks.resolveWorkflowGithubToken.mockReset();
    vi.stubEnv("INTERNAL_API_TOKEN", "internal-token");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("uses the ready endpoint returned by the SEA provisioning adapter", async () => {
    mocks.maybeProvisionAgentWorkflowHost.mockResolvedValue({
      agentAppId: "agent-exec-1__promote",
      sandboxName: "agent-host-agent-exec-1-promote",
      status: "ready",
      baseUrl: "http://10.244.1.20:8002",
      podIP: "10.244.1.20",
    });

    await expect(
      provisionWorkspaceHelperPod("exec-1", "promote", {
        githubToken: "github-token",
      }),
    ).resolves.toEqual({
      baseUrl: "http://10.244.1.20:8002",
      token: "internal-token",
      githubToken: "github-token",
    });
    expect(mocks.maybeProvisionAgentWorkflowHost).toHaveBeenCalledTimes(1);
  });

  it("fails closed when SEA has not returned a ready endpoint", async () => {
    mocks.maybeProvisionAgentWorkflowHost.mockResolvedValue({
      agentAppId: "agent-exec-1__promote",
      sandboxName: "agent-host-agent-exec-1-promote",
      status: "queued",
    });

    await expect(
      provisionWorkspaceHelperPod("exec-1", "promote"),
    ).resolves.toBeNull();
    expect(mocks.maybeProvisionAgentWorkflowHost).toHaveBeenCalledTimes(1);
  });
});

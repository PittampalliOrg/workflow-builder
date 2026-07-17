import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteKubernetesSandbox: vi.fn(),
  maybeProvisionAgentWorkflowHost: vi.fn(),
  resolveWorkflowGithubToken: vi.fn(),
}));

vi.mock("$env/dynamic/private", () => ({ env: process.env }));
vi.mock("$lib/server/kube/client", () => ({
  deleteKubernetesSandbox: mocks.deleteKubernetesSandbox,
}));
vi.mock("$lib/server/sessions/agent-workflow-host", () => ({
  maybeProvisionAgentWorkflowHost: mocks.maybeProvisionAgentWorkflowHost,
}));
vi.mock("$lib/server/workflows/github-token", () => ({
  resolveWorkflowGithubToken: mocks.resolveWorkflowGithubToken,
}));

import {
  cleanupWorkspaceHelperPod,
  provisionWorkspaceHelperPod,
} from "./helper-pod";

describe("workspace helper provisioning boundary", () => {
  beforeEach(() => {
    mocks.deleteKubernetesSandbox.mockReset();
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
      sandboxName: "agent-host-agent-exec-1-promote",
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

  it("deletes the helper sandbox through the Kubernetes adapter", async () => {
    mocks.deleteKubernetesSandbox.mockResolvedValue("deleted");

    await expect(
      cleanupWorkspaceHelperPod({
        sandboxName: "agent-host-agent-exec-1-promote",
      }),
    ).resolves.toBe("deleted");
    expect(mocks.deleteKubernetesSandbox).toHaveBeenCalledWith(
      "agent-host-agent-exec-1-promote",
    );
  });

  it("skips cleanup when provisioning never returned a sandbox name", async () => {
    await expect(cleanupWorkspaceHelperPod(null)).resolves.toBe("skipped");
    await expect(cleanupWorkspaceHelperPod({ sandboxName: "" })).resolves.toBe(
      "skipped",
    );
    expect(mocks.deleteKubernetesSandbox).not.toHaveBeenCalled();
  });

  it("contains helper sandbox cleanup failures", async () => {
    mocks.deleteKubernetesSandbox.mockRejectedValue(new Error("api down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      cleanupWorkspaceHelperPod({
        sandboxName: "agent-host-agent-exec-1-promote",
      }),
    ).resolves.toBe("failed");
    expect(warn).toHaveBeenCalledWith(
      "[helper-pod] cleanup failed for agent-host-agent-exec-1-promote:",
      "api down",
    );
    warn.mockRestore();
  });
});

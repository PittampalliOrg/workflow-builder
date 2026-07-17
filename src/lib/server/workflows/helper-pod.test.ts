import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteCliStorageForSession: vi.fn(),
  deleteKubernetesSandbox: vi.fn(),
  waitForKubernetesSandboxDeleted: vi.fn(),
  maybeProvisionAgentWorkflowHost: vi.fn(),
  resolveWorkflowGithubToken: vi.fn(),
}));

vi.mock("$env/dynamic/private", () => ({ env: process.env }));
vi.mock("$lib/server/kube/client", () => ({
  deleteCliStorageForSession: mocks.deleteCliStorageForSession,
  deleteKubernetesSandbox: mocks.deleteKubernetesSandbox,
  waitForKubernetesSandboxDeleted: mocks.waitForKubernetesSandboxDeleted,
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
    mocks.deleteCliStorageForSession.mockReset();
    mocks.deleteKubernetesSandbox.mockReset();
    mocks.waitForKubernetesSandboxDeleted.mockReset();
    mocks.maybeProvisionAgentWorkflowHost.mockReset();
    mocks.resolveWorkflowGithubToken.mockReset();
    vi.stubEnv("INTERNAL_API_TOKEN", "internal-token");
    mocks.deleteCliStorageForSession.mockResolvedValue({
      persistentVolumeClaims: [],
      persistentVolumes: [],
    });
    mocks.waitForKubernetesSandboxDeleted.mockResolvedValue("deleted");
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
      helperSessionId: "exec-1__promote",
      sharedWorkspaceKey: "exec-1__promote",
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

  it("deletes the helper sandbox and CLI storage through the Kubernetes adapter", async () => {
    mocks.deleteKubernetesSandbox.mockResolvedValue("deleted");
    mocks.deleteCliStorageForSession.mockResolvedValue({
      persistentVolumeClaims: ["cli-ws-exec-1"],
      persistentVolumes: ["cli-ws-exec-1"],
    });

    await expect(
      cleanupWorkspaceHelperPod({
        helperSessionId: "exec-1__promote",
        sandboxName: "agent-host-agent-exec-1-promote",
      }),
    ).resolves.toBe("deleted");
    expect(mocks.deleteKubernetesSandbox).toHaveBeenCalledWith(
      "agent-host-agent-exec-1-promote",
    );
    expect(mocks.waitForKubernetesSandboxDeleted).toHaveBeenCalledWith(
      "agent-host-agent-exec-1-promote",
    );
    expect(mocks.deleteCliStorageForSession).toHaveBeenCalledWith(
      "exec-1__promote",
    );
  });

  it("skips cleanup when provisioning never returned a sandbox name", async () => {
    await expect(cleanupWorkspaceHelperPod(null)).resolves.toBe("skipped");
    await expect(cleanupWorkspaceHelperPod({ sandboxName: "" })).resolves.toBe(
      "skipped",
    );
    expect(mocks.deleteKubernetesSandbox).not.toHaveBeenCalled();
    expect(mocks.waitForKubernetesSandboxDeleted).not.toHaveBeenCalled();
    expect(mocks.deleteCliStorageForSession).not.toHaveBeenCalled();
  });

  it("contains helper sandbox cleanup failures", async () => {
    mocks.deleteKubernetesSandbox.mockRejectedValue(new Error("api down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      cleanupWorkspaceHelperPod({
        helperSessionId: "exec-1__promote",
        sandboxName: "agent-host-agent-exec-1-promote",
      }),
    ).resolves.toBe("failed");
    expect(warn).toHaveBeenCalledWith(
      "[helper-pod] cleanup failed for agent-host-agent-exec-1-promote:",
      "api down",
    );
    warn.mockRestore();
  });

  it("does not delete helper storage while the helper sandbox is still terminating", async () => {
    mocks.deleteKubernetesSandbox.mockResolvedValue("deleted");
    mocks.waitForKubernetesSandboxDeleted.mockResolvedValue("timeout");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      cleanupWorkspaceHelperPod({
        helperSessionId: "exec-1__promote",
        sandboxName: "agent-host-agent-exec-1-promote",
      }),
    ).resolves.toBe("failed");
    expect(mocks.deleteCliStorageForSession).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[helper-pod] cleanup failed for agent-host-agent-exec-1-promote:",
      "sandbox agent-host-agent-exec-1-promote did not terminate before storage cleanup",
    );
    warn.mockRestore();
  });

  it("contains helper storage cleanup failures", async () => {
    mocks.deleteKubernetesSandbox.mockResolvedValue("missing");
    mocks.deleteCliStorageForSession.mockRejectedValue(new Error("pvc down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      cleanupWorkspaceHelperPod({
        helperSessionId: "exec-1__promote",
        sandboxName: "agent-host-agent-exec-1-promote",
      }),
    ).resolves.toBe("failed");
    expect(warn).toHaveBeenCalledWith(
      "[helper-pod] cleanup failed for agent-host-agent-exec-1-promote:",
      "pvc down",
    );
    warn.mockRestore();
  });
});

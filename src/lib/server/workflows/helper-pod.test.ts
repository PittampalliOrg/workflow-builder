import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteCliStorageForSession: vi.fn(),
  maybeProvisionAgentWorkflowHost: vi.fn(),
  resolveWorkflowGithubToken: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("$env/dynamic/private", () => ({ env: process.env }));
vi.mock("$lib/server/kube/client", () => ({
  deleteCliStorageForSession: mocks.deleteCliStorageForSession,
}));
vi.mock("$lib/server/sessions/agent-workflow-host", () => ({
  maybeProvisionAgentWorkflowHost: mocks.maybeProvisionAgentWorkflowHost,
  sessionHostAppId: (sessionId: string) =>
    sessionId === "exec-1__preview-source-promotion"
      ? "agent-session-derived"
      : `agent-session-${sessionId}`,
}));
vi.mock("$lib/server/workflows/github-token", () => ({
  resolveWorkflowGithubToken: mocks.resolveWorkflowGithubToken,
}));

import {
  cleanupWorkspaceHelperPod,
  provisionWorkspaceHelperPod,
} from "./helper-pod";

function seaResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("workspace helper provisioning boundary", () => {
  beforeEach(() => {
    mocks.deleteCliStorageForSession.mockReset();
    mocks.maybeProvisionAgentWorkflowHost.mockReset();
    mocks.resolveWorkflowGithubToken.mockReset();
    mocks.fetch.mockReset();
    vi.stubGlobal("fetch", mocks.fetch);
    vi.stubEnv("INTERNAL_API_TOKEN", "internal-token");
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sea:8080");
    vi.stubEnv("SANDBOX_EXECUTION_API_TOKEN", "sea-token");
    mocks.deleteCliStorageForSession.mockResolvedValue({
      persistentVolumeClaims: [],
      persistentVolumes: [],
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

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

  it("deletes the helper sandbox through the privileged SEA delete endpoint", async () => {
    mocks.fetch.mockResolvedValue(
      seaResponse(200, {
        agentAppId: "agent-session-derived",
        sandboxName: "agent-host-agent-session-derived",
        outcome: "deleted",
      }),
    );

    await expect(
      cleanupWorkspaceHelperPod({
        helperSessionId: "exec-1__preview-source-promotion",
        sandboxName: "agent-host-agent-session-derived",
      }),
    ).resolves.toBe("deleted");
    expect(mocks.fetch).toHaveBeenCalledWith(
      "http://sea:8080/api/v1/agent-workflow-hosts/agent-session-derived",
      {
        method: "DELETE",
        headers: { Authorization: "Bearer sea-token" },
      },
    );
    expect(mocks.deleteCliStorageForSession).toHaveBeenCalledWith(
      "exec-1__preview-source-promotion",
    );
  });

  it("maps an absent host (not-found) to missing", async () => {
    mocks.fetch.mockResolvedValue(
      seaResponse(200, {
        agentAppId: "agent-session-derived",
        outcome: "not-found",
      }),
    );

    await expect(
      cleanupWorkspaceHelperPod({
        helperSessionId: "exec-1__preview-source-promotion",
      }),
    ).resolves.toBe("missing");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("derives the app id from the sandbox name when only the name is known", async () => {
    mocks.fetch.mockResolvedValue(
      seaResponse(200, { outcome: "deleted" }),
    );

    await expect(
      cleanupWorkspaceHelperPod({
        sandboxName: "agent-host-agent-session-xyz",
      }),
    ).resolves.toBe("deleted");
    expect(mocks.fetch).toHaveBeenCalledWith(
      "http://sea:8080/api/v1/agent-workflow-hosts/agent-session-xyz",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(mocks.deleteCliStorageForSession).not.toHaveBeenCalled();
  });

  it("skips cleanup when provisioning returned no cleanup identity", async () => {
    await expect(cleanupWorkspaceHelperPod(null)).resolves.toBe("skipped");
    await expect(cleanupWorkspaceHelperPod({ sandboxName: "" })).resolves.toBe(
      "skipped",
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.deleteCliStorageForSession).not.toHaveBeenCalled();
  });

  it("fails when SEA rejects the delete", async () => {
    mocks.fetch.mockResolvedValue(
      seaResponse(503, { detail: "agent-host lookup failed" }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      cleanupWorkspaceHelperPod({
        helperSessionId: "exec-1__preview-source-promotion",
      }),
    ).resolves.toBe("failed");
    expect(warn).toHaveBeenCalledWith(
      "[helper-pod] cleanup failed for agent-session-derived:",
      "agent-host lookup failed",
    );
    expect(mocks.deleteCliStorageForSession).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("fails when SEA reports the sandbox is still terminating", async () => {
    mocks.fetch.mockResolvedValue(
      seaResponse(200, {
        outcome: "error",
        message: "sandbox delete requested but the CR is still terminating",
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      cleanupWorkspaceHelperPod({
        helperSessionId: "exec-1__preview-source-promotion",
      }),
    ).resolves.toBe("failed");
    expect(warn).toHaveBeenCalledWith(
      "[helper-pod] cleanup failed for agent-session-derived:",
      "sandbox delete requested but the CR is still terminating",
    );
    warn.mockRestore();
  });

  it("fails when the SEA endpoint is not configured", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "");
    vi.stubEnv("HOST_EXECUTION_API_URL", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      cleanupWorkspaceHelperPod({
        helperSessionId: "exec-1__preview-source-promotion",
      }),
    ).resolves.toBe("failed");
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[helper-pod] cleanup failed for agent-session-derived:",
      "SANDBOX_EXECUTION_API_URL is not configured",
    );
    warn.mockRestore();
  });

  it("keeps the delete outcome when best-effort storage cleanup fails", async () => {
    mocks.fetch.mockResolvedValue(seaResponse(200, { outcome: "deleted" }));
    mocks.deleteCliStorageForSession.mockRejectedValue(new Error("pvc down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      cleanupWorkspaceHelperPod({
        helperSessionId: "exec-1__preview-source-promotion",
      }),
    ).resolves.toBe("deleted");
    expect(warn).toHaveBeenCalledWith(
      "[helper-pod] storage cleanup failed for exec-1__preview-source-promotion:",
      "pvc down",
    );
    warn.mockRestore();
  });
});

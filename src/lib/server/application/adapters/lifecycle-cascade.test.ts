import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  daprFetch: vi.fn(),
  deleteSessionRuntimeExitedPods: vi.fn(),
  getAgentWorkflowHostPod: vi.fn(),
  getKubernetesSandbox: vi.fn(),
  getSessionRuntimePodPresence: vi.fn(),
  getSessionRuntimePodStatus: vi.fn(),
  resumeSessionSandbox: vi.fn(),
  sandboxDesiredRunning: vi.fn(),
  waitForAgentWorkflowHostAppReady: vi.fn(),
  openshellRuntimeFetch: vi.fn(),
}));

vi.mock("$lib/server/dapr-client", () => ({
  daprFetch: (...args: unknown[]) => mocks.daprFetch(...args),
  getDaprSidecarUrl: () => "http://dapr-sidecar:3500",
  getOrchestratorUrl: () => "http://workflow-orchestrator:8080",
  getWorkspaceRuntimeUrl: () => "http://openshell-agent-runtime:8080",
}));

vi.mock("$lib/server/openshell-runtime", () => ({
  openshellRuntimeFetch: (...args: unknown[]) =>
    mocks.openshellRuntimeFetch(...args),
}));

vi.mock("$lib/server/kube/client", () => ({
  deleteSessionRuntimeExitedPods: (...args: unknown[]) =>
    mocks.deleteSessionRuntimeExitedPods(...args),
  getAgentWorkflowHostPod: (...args: unknown[]) =>
    mocks.getAgentWorkflowHostPod(...args),
  getKubernetesSandbox: (...args: unknown[]) =>
    mocks.getKubernetesSandbox(...args),
  getSessionRuntimePodPresence: (...args: unknown[]) =>
    mocks.getSessionRuntimePodPresence(...args),
  getSessionRuntimePodStatus: (...args: unknown[]) =>
    mocks.getSessionRuntimePodStatus(...args),
  resumeSessionSandbox: (...args: unknown[]) =>
    mocks.resumeSessionSandbox(...args),
  sandboxDesiredRunning: (...args: unknown[]) =>
    mocks.sandboxDesiredRunning(...args),
}));

vi.mock("$lib/server/sessions/agent-workflow-host", () => ({
  waitForAgentWorkflowHostAppReady: (...args: unknown[]) =>
    mocks.waitForAgentWorkflowHostAppReady(...args),
}));

vi.mock("$lib/server/db", () => ({ db: null }));

import {
  createDaprCascadeDeps,
  DaprSessionRuntimeCleanupAdapter,
} from "$lib/server/application/adapters/lifecycle-cascade";
import { DURABLE_RUNTIME_MISSING_STATUS } from "$lib/server/lifecycle/cascade";
import { agentTargetForSession } from "$lib/server/lifecycle/resolvers";

const RUNTIME_APP_ID = "agent-session-abc";
const SANDBOX_NAME = "agent-host-agent-session-abc";

describe("Dapr lifecycle cascade agent-runtime transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAgentWorkflowHostPod.mockResolvedValue(null);
    mocks.getKubernetesSandbox.mockResolvedValue(null);
    mocks.getSessionRuntimePodPresence.mockResolvedValue("absent");
    mocks.getSessionRuntimePodStatus.mockResolvedValue({
      presence: "absent",
      exited: false,
    });
    mocks.deleteSessionRuntimeExitedPods.mockResolvedValue([]);
    mocks.sandboxDesiredRunning.mockReturnValue(false);
    mocks.resumeSessionSandbox.mockResolvedValue("patched");
    mocks.waitForAgentWorkflowHostAppReady.mockResolvedValue({
      baseUrl: "http://10.244.1.21:8002",
    });
    mocks.openshellRuntimeFetch.mockResolvedValue(
      new Response("{}", { status: 200 }),
    );
  });

  it("adapts unpublished-session cleanup to the strict lifecycle purge", async () => {
    const purgeAgentRuntime = vi.fn(async () => undefined);
    const adapter = new DaprSessionRuntimeCleanupAdapter({
      purgeAgentRuntime,
    });

    await adapter.purgeRuntimeInstance({
      runtimeAppId: RUNTIME_APP_ID,
      instanceId: "session-1",
      runtimeSandboxName: SANDBOX_NAME,
    });

    expect(purgeAgentRuntime).toHaveBeenCalledWith(
      RUNTIME_APP_ID,
      "session-1",
      SANDBOX_NAME,
    );
  });

  it("binds provider deletion to the canonical app and Sandbox target", async () => {
    const deleteRuntimeSandbox = vi.fn(async (name: string) => ({
      name,
      kind: "runtime" as const,
      status: "deleted" as const,
    }));
    const deps = createDaprCascadeDeps({
      sandboxDestroyer: { deleteRuntimeSandbox },
    });

    await expect(
      deps.deleteRuntimeSandbox?.({
        runtimeAppId: RUNTIME_APP_ID,
        runtimeSandboxName: SANDBOX_NAME,
      }),
    ).resolves.toBeUndefined();
    await expect(
      deps.deleteRuntimeSandbox?.({
        runtimeAppId: RUNTIME_APP_ID,
        runtimeSandboxName: "agent-host-agent-session-stale",
      }),
    ).rejects.toThrow(
      "runtime target mismatch: agent-session-abc does not own agent-host-agent-session-stale",
    );
    expect(deleteRuntimeSandbox).toHaveBeenCalledOnce();
    expect(deleteRuntimeSandbox).toHaveBeenCalledWith(SANDBOX_NAME);
  });

  it("strictly deletes named and execution-scoped OpenShell workspaces", async () => {
    const deps = createDaprCascadeDeps();
    mocks.daprFetch.mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await expect(
      deps.deleteWorkspaceSandbox?.("workspace-session-1"),
    ).resolves.toBeUndefined();
    await expect(
      deps.cleanupWorkspaceExecution?.("workflow-execution-1"),
    ).resolves.toBeUndefined();

    expect(mocks.openshellRuntimeFetch).toHaveBeenCalledWith(
      "/api/v1/sandboxes/workspace-session-1",
      { method: "DELETE" },
    );
    expect(mocks.daprFetch).toHaveBeenCalledWith(
      "http://openshell-agent-runtime:8080/api/workspaces/cleanup",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ executionId: "workflow-execution-1" }),
      }),
    );
  });

  it("treats missing workspaces as cleaned but propagates real deletion failures", async () => {
    const deps = createDaprCascadeDeps();
    mocks.openshellRuntimeFetch
      .mockResolvedValueOnce(new Response("sandbox not found", { status: 404 }))
      .mockResolvedValueOnce(
        new Response("runtime unavailable", { status: 503 }),
      );

    await expect(
      deps.deleteWorkspaceSandbox?.("workspace-missing"),
    ).resolves.toBeUndefined();
    await expect(
      deps.deleteWorkspaceSandbox?.("workspace-stuck"),
    ).rejects.toThrow("deletion failed (503)");
  });

  it("routes every explicitly sandboxed lifecycle operation directly to the host", async () => {
    const locateHost = vi.fn(async () => ({
      state: "ready" as const,
      baseUrl: "http://10.244.1.20:8002",
    }));
    const deps = createDaprCascadeDeps({
      locateAgentWorkflowHost: locateHost,
      waitMs: 1,
    });
    mocks.daprFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ runtimeStatus: "RUNNING" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await expect(
      deps.getAgentRuntimeStatus(RUNTIME_APP_ID, "session-1", SANDBOX_NAME),
    ).resolves.toBe("RUNNING");
    await expect(
      deps.cancelAgentRuntime?.(
        RUNTIME_APP_ID,
        "session-1",
        "stop",
        SANDBOX_NAME,
      ),
    ).resolves.toBe("requested");
    await expect(
      deps.terminateAgentRuntime(
        RUNTIME_APP_ID,
        "session-1",
        "stop",
        SANDBOX_NAME,
      ),
    ).resolves.toBe("terminated");
    await expect(
      deps.purgeAgentRuntime(RUNTIME_APP_ID, "session-1", SANDBOX_NAME),
    ).resolves.toBeUndefined();

    expect(mocks.daprFetch.mock.calls.map(([url]) => url)).toEqual([
      "http://10.244.1.20:8002/api/v2/agent-runs/session-1/status?summary=true",
      "http://10.244.1.20:8002/internal/sessions/raise-event",
      "http://10.244.1.20:8002/api/v2/agent-runs/session-1/terminate",
      "http://10.244.1.20:8002/api/v2/agent-runs/session-1?recursive=true",
    ]);
    expect(locateHost).toHaveBeenCalledTimes(4);
    expect(locateHost).toHaveBeenCalledWith(RUNTIME_APP_ID, SANDBOX_NAME);
  });

  it("keeps targets without explicit Sandbox evidence on Dapr", async () => {
    const locateHost = vi.fn(async () => ({
      state: "ready" as const,
      baseUrl: "http://should-not-be-used:8002",
    }));
    const deps = createDaprCascadeDeps({ locateAgentWorkflowHost: locateHost });
    mocks.daprFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ runtimeStatus: "COMPLETED" }), {
        status: 200,
      }),
    );

    await expect(
      deps.getAgentRuntimeStatus(RUNTIME_APP_ID, "session-1", null),
    ).resolves.toBe("COMPLETED");
    expect(locateHost).not.toHaveBeenCalled();
    expect(mocks.daprFetch).toHaveBeenCalledWith(
      "http://dapr-sidecar:3500/v1.0/invoke/agent-session-abc/method/api/v2/agent-runs/session-1/status?summary=true",
      expect.objectContaining({ method: "GET", maxRetries: 0 }),
    );
  });

  it("routes a deterministic app id with a lagging Sandbox-name write through direct discovery", async () => {
    const target = agentTargetForSession({
      id: "session-legacy",
      daprInstanceId: "run-legacy",
      runtimeAppId: "agent-session-legacy",
      runtimeSandboxName: null,
    });
    expect(target?.runtimeSandboxName).toBe("agent-host-agent-session-legacy");
    const deps = createDaprCascadeDeps();

    await expect(
      deps.getAgentRuntimeStatus(
        target!.runtimeAppId,
        target!.instanceId,
        target!.runtimeSandboxName,
      ),
    ).resolves.toBe(DURABLE_RUNTIME_MISSING_STATUS);
    expect(mocks.getKubernetesSandbox).toHaveBeenCalledWith(
      "agent-host-agent-session-legacy",
    );
    expect(mocks.daprFetch).not.toHaveBeenCalled();
  });

  it("closes only when both the Sandbox CR and pod are positively absent", async () => {
    const deps = createDaprCascadeDeps();

    await expect(
      deps.getAgentRuntimeStatus(RUNTIME_APP_ID, "session-1", SANDBOX_NAME),
    ).resolves.toBe(DURABLE_RUNTIME_MISSING_STATUS);
    await expect(
      deps.terminateAgentRuntime(
        RUNTIME_APP_ID,
        "session-1",
        "stop",
        SANDBOX_NAME,
      ),
    ).resolves.toBe("alreadyGone");
    expect(mocks.daprFetch).not.toHaveBeenCalled();
    expect(mocks.getKubernetesSandbox).toHaveBeenCalledWith(SANDBOX_NAME);
    expect(mocks.getSessionRuntimePodPresence).toHaveBeenCalledWith({
      runtimeAppId: RUNTIME_APP_ID,
    });
  });

  it("keeps a scaled-to-zero Sandbox unknown without waking it during status", async () => {
    mocks.getKubernetesSandbox.mockResolvedValue({
      metadata: { name: SANDBOX_NAME },
      spec: { replicas: 0 },
    });
    const deps = createDaprCascadeDeps();

    await expect(
      deps.getAgentRuntimeStatus(RUNTIME_APP_ID, "session-1", SANDBOX_NAME),
    ).resolves.toBeNull();
    expect(mocks.resumeSessionSandbox).not.toHaveBeenCalled();
    expect(mocks.waitForAgentWorkflowHostAppReady).not.toHaveBeenCalled();
    expect(mocks.getSessionRuntimePodStatus).not.toHaveBeenCalled();
    expect(mocks.daprFetch).not.toHaveBeenCalled();
  });

  it("wakes a suspended Sandbox before terminate and purge control operations", async () => {
    mocks.getKubernetesSandbox.mockResolvedValue({
      metadata: { name: SANDBOX_NAME },
      spec: { replicas: 0 },
    });
    mocks.daprFetch
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const deps = createDaprCascadeDeps();

    await expect(
      deps.terminateAgentRuntime(
        RUNTIME_APP_ID,
        "session-1",
        "stop",
        SANDBOX_NAME,
      ),
    ).resolves.toBe("terminated");
    await expect(
      deps.purgeAgentRuntime(RUNTIME_APP_ID, "session-1", SANDBOX_NAME),
    ).resolves.toBeUndefined();

    expect(mocks.resumeSessionSandbox).toHaveBeenCalledTimes(2);
    expect(mocks.resumeSessionSandbox).toHaveBeenNthCalledWith(1, SANDBOX_NAME);
    expect(mocks.resumeSessionSandbox).toHaveBeenNthCalledWith(2, SANDBOX_NAME);
    expect(mocks.waitForAgentWorkflowHostAppReady).toHaveBeenCalledTimes(2);
    expect(mocks.daprFetch.mock.calls.map(([url]) => url)).toEqual([
      "http://10.244.1.21:8002/api/v2/agent-runs/session-1/terminate",
      "http://10.244.1.21:8002/api/v2/agent-runs/session-1?recursive=true",
    ]);
  });

  it("waits for application readiness before controlling an already-addressable pod", async () => {
    mocks.getAgentWorkflowHostPod.mockResolvedValue({ podIP: "10.244.1.20" });
    mocks.daprFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ runtimeStatus: "RUNNING" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const deps = createDaprCascadeDeps();

    await expect(
      deps.getAgentRuntimeStatus(RUNTIME_APP_ID, "session-1", SANDBOX_NAME),
    ).resolves.toBe("RUNNING");
    expect(mocks.waitForAgentWorkflowHostAppReady).not.toHaveBeenCalled();

    await expect(
      deps.terminateAgentRuntime(
        RUNTIME_APP_ID,
        "session-1",
        "stop",
        SANDBOX_NAME,
      ),
    ).resolves.toBe("terminated");
    expect(mocks.waitForAgentWorkflowHostAppReady).toHaveBeenCalledWith({
      agentAppId: RUNTIME_APP_ID,
    });
    expect(mocks.daprFetch).toHaveBeenLastCalledWith(
      "http://10.244.1.21:8002/api/v2/agent-runs/session-1/terminate",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("allows an idempotent control retry after readiness fails without making status activate the host", async () => {
    mocks.getAgentWorkflowHostPod.mockResolvedValue({ podIP: "10.244.1.20" });
    mocks.waitForAgentWorkflowHostAppReady
      .mockRejectedValueOnce(new Error("application still starting"))
      .mockResolvedValueOnce({ baseUrl: "http://10.244.1.21:8002" });
    mocks.daprFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ runtimeStatus: "RUNNING" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const deps = createDaprCascadeDeps();

    await expect(
      deps.terminateAgentRuntime(
        RUNTIME_APP_ID,
        "session-1",
        "stop",
        SANDBOX_NAME,
      ),
    ).resolves.toBe("failed");
    expect(mocks.daprFetch).not.toHaveBeenCalled();

    await expect(
      deps.getAgentRuntimeStatus(RUNTIME_APP_ID, "session-1", SANDBOX_NAME),
    ).resolves.toBe("RUNNING");
    expect(mocks.waitForAgentWorkflowHostAppReady).toHaveBeenCalledTimes(1);

    await expect(
      deps.terminateAgentRuntime(
        RUNTIME_APP_ID,
        "session-1",
        "stop",
        SANDBOX_NAME,
      ),
    ).resolves.toBe("terminated");
    expect(mocks.waitForAgentWorkflowHostAppReady).toHaveBeenCalledTimes(2);
    expect(mocks.daprFetch.mock.calls.map(([url]) => url)).toEqual([
      "http://10.244.1.20:8002/api/v2/agent-runs/session-1/status?summary=true",
      "http://10.244.1.21:8002/api/v2/agent-runs/session-1/terminate",
    ]);
  });

  it("keeps an unready or unobservable Sandbox location unknown", async () => {
    mocks.getSessionRuntimePodPresence.mockResolvedValue("unknown");
    const deps = createDaprCascadeDeps();

    await expect(
      deps.getAgentRuntimeStatus(RUNTIME_APP_ID, "session-1", SANDBOX_NAME),
    ).resolves.toBeNull();
    await expect(
      deps.terminateAgentRuntime(
        RUNTIME_APP_ID,
        "session-1",
        "stop",
        SANDBOX_NAME,
      ),
    ).resolves.toBe("failed");
    expect(mocks.daprFetch).not.toHaveBeenCalled();
  });

  it("propagates non-benign parent and agent purge failures", async () => {
    const parentDeps = createDaprCascadeDeps();
    mocks.daprFetch.mockResolvedValueOnce(
      new Response("orchestrator unavailable", { status: 503 }),
    );
    await expect(parentDeps.purgeParent("workflow-1")).rejects.toThrow(
      "workflow purge failed with 503",
    );

    vi.clearAllMocks();
    const agentDeps = createDaprCascadeDeps({
      locateAgentWorkflowHost: vi.fn(async () => ({
        state: "ready" as const,
        baseUrl: "http://10.244.1.20:8002",
      })),
    });
    mocks.daprFetch.mockResolvedValueOnce(
      new Response("runtime unavailable", { status: 500 }),
    );
    await expect(
      agentDeps.purgeAgentRuntime(RUNTIME_APP_ID, "session-1", SANDBOX_NAME),
    ).rejects.toThrow("agent runtime purge failed with 500");
  });

  it("propagates state-row purge failures for lifecycle retry", async () => {
    const database = {
      execute: vi.fn(async () => {
        throw new Error("postgres unavailable");
      }),
    } as unknown as NonNullable<Parameters<typeof createDaprCascadeDeps>[1]>;
    const deps = createDaprCascadeDeps({}, database);

    await expect(deps.purgeStateRows?.(["workflow-1"], [], [])).rejects.toThrow(
      "postgres unavailable",
    );
  });

  it("falls back to the state.postgresql/v1 state table when the prefixed workflow table is absent", async () => {
    const missingPrefixedTable = new Error("query failed", {
      cause: Object.assign(
        new Error('relation "wfstate_state" does not exist'),
        {
          code: "42P01",
        },
      ),
    });
    const database = {
      execute: vi
        .fn()
        .mockRejectedValueOnce(missingPrefixedTable)
        .mockResolvedValue(undefined),
    } as unknown as NonNullable<Parameters<typeof createDaprCascadeDeps>[1]>;
    const deps = createDaprCascadeDeps({}, database);

    await expect(
      deps.purgeStateRows?.(["workflow-1", "workflow-2"], [], []),
    ).resolves.toBeUndefined();

    // Missing wfstate_state, then legacy state for both workflow ids, followed
    // by agent_py_state for both ids.
    expect(database.execute).toHaveBeenCalledTimes(5);
  });

  it("keeps state cleanup fail-closed when both workflow state tables are absent", async () => {
    const missingTable = () =>
      Object.assign(new Error("query failed"), { code: "42P01" });
    const database = {
      execute: vi
        .fn()
        .mockRejectedValueOnce(missingTable())
        .mockRejectedValueOnce(missingTable()),
    } as unknown as NonNullable<Parameters<typeof createDaprCascadeDeps>[1]>;
    const deps = createDaprCascadeDeps({}, database);

    await expect(deps.purgeStateRows?.(["workflow-1"], [], [])).rejects.toThrow(
      "Failed to delete Dapr state rows from state",
    );
    expect(database.execute).toHaveBeenCalledTimes(2);
  });

  it("keeps CR read failures and pending pods unknown", async () => {
    mocks.getKubernetesSandbox.mockRejectedValueOnce(
      new Error("kube unavailable"),
    );
    const crFailureDeps = createDaprCascadeDeps();

    await expect(
      crFailureDeps.getAgentRuntimeStatus(
        RUNTIME_APP_ID,
        "session-1",
        SANDBOX_NAME,
      ),
    ).resolves.toBeNull();
    expect(mocks.getSessionRuntimePodPresence).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.getAgentWorkflowHostPod.mockResolvedValue(null);
    mocks.getKubernetesSandbox.mockResolvedValue(null);
    mocks.getSessionRuntimePodPresence.mockResolvedValue("present");
    const pendingPodDeps = createDaprCascadeDeps();
    await expect(
      pendingPodDeps.getAgentRuntimeStatus(
        RUNTIME_APP_ID,
        "session-2",
        SANDBOX_NAME,
      ),
    ).resolves.toBeNull();
    expect(mocks.daprFetch).not.toHaveBeenCalled();
  });

  it("uses the legacy Pydantic status endpoint when the standard route is unsupported", async () => {
    const deps = createDaprCascadeDeps({
      locateAgentWorkflowHost: vi.fn(async () => ({
        state: "ready" as const,
        baseUrl: "http://10.244.1.20:8002",
      })),
    });
    mocks.daprFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ runtime_status: "RUNNING" }), {
          status: 200,
        }),
      );

    await expect(
      deps.getAgentRuntimeStatus(RUNTIME_APP_ID, "session-1", SANDBOX_NAME),
    ).resolves.toBe("RUNNING");
    expect(mocks.daprFetch.mock.calls.map(([url]) => url)).toEqual([
      "http://10.244.1.20:8002/api/v2/agent-runs/session-1/status?summary=true",
      "http://10.244.1.20:8002/agent/instances/session-1",
    ]);
  });

  it("accepts only the canonical missing response and does not mask HTTP 500", async () => {
    const deps = createDaprCascadeDeps({
      locateAgentWorkflowHost: vi.fn(async () => ({
        state: "ready" as const,
        baseUrl: "http://10.244.1.20:8002",
      })),
    });
    mocks.daprFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: "Agent run not found" }), {
          status: 404,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: "instance not found" }), {
          status: 404,
        }),
      )
      .mockResolvedValueOnce(new Response("runtime exploded", { status: 500 }));

    await expect(
      deps.getAgentRuntimeStatus(RUNTIME_APP_ID, "missing", SANDBOX_NAME),
    ).resolves.toBe(DURABLE_RUNTIME_MISSING_STATUS);
    await expect(
      deps.getAgentRuntimeStatus(RUNTIME_APP_ID, "unsupported", SANDBOX_NAME),
    ).resolves.toBeNull();
    await expect(
      deps.getAgentRuntimeStatus(RUNTIME_APP_ID, "live", SANDBOX_NAME),
    ).rejects.toThrow("status request failed with 500: runtime exploded");
  });

  it("accepts a direct request race only after both CR and pod disappear", async () => {
    mocks.getAgentWorkflowHostPod
      .mockResolvedValueOnce({ podIP: "10.244.1.20" })
      .mockResolvedValueOnce(null);
    mocks.getKubernetesSandbox.mockResolvedValue(null);
    mocks.getSessionRuntimePodPresence.mockResolvedValue("absent");
    const deps = createDaprCascadeDeps();
    mocks.daprFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(
      deps.getAgentRuntimeStatus(RUNTIME_APP_ID, "session-1", SANDBOX_NAME),
    ).resolves.toBe(DURABLE_RUNTIME_MISSING_STATUS);
    expect(mocks.getKubernetesSandbox).toHaveBeenCalledWith(SANDBOX_NAME);
    expect(mocks.getSessionRuntimePodPresence).toHaveBeenCalledWith({
      runtimeAppId: RUNTIME_APP_ID,
    });
  });
});

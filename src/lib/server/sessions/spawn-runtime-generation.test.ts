import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionDetail: vi.fn(),
  resolveSessionAgent: vi.fn(),
  reserveSessionRuntimeProvisioning: vi.fn(),
  releaseSessionRuntimeProvisioning: vi.fn(),
  stageSessionRuntimeProvisioning: vi.fn(),
  attachStagedSessionRuntimeProvisioning: vi.fn(),
  completeSessionRuntimeHostRecovery: vi.fn(),
  listSessionEvents: vi.fn(),
  getSessionFileOwner: vi.fn(),
  initialUserEvents: vi.fn(),
  requestDeliveryAfterRuntimePublished: vi.fn(),
  flattenBundles: vi.fn(),
  signSessionToken: vi.fn(),
  cleanupUnpublishedRuntimeProvisioning: vi.fn(),
  daprFetch: vi.fn(),
  resolveAgentConfigMcpForProject: vi.fn(),
  resolveAgentRuntimeRoute: vi.fn(),
  maybeProvisionAgentWorkflowHost: vi.fn(),
  recreateAgentWorkflowHostGeneration: vi.fn(),
  waitForAgentWorkflowHostAppReady: vi.fn(),
  ensurePublishedAgentWorkflowHostGeneration: vi.fn(),
  getRuntimeDescriptor: vi.fn(),
  evaluateSwap: vi.fn(),
}));

vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    workflowData: {
      getSessionDetail: mocks.getSessionDetail,
      resolveSessionAgent: mocks.resolveSessionAgent,
      reserveSessionRuntimeProvisioning:
        mocks.reserveSessionRuntimeProvisioning,
      releaseSessionRuntimeProvisioning:
        mocks.releaseSessionRuntimeProvisioning,
      stageSessionRuntimeProvisioning: mocks.stageSessionRuntimeProvisioning,
      attachStagedSessionRuntimeProvisioning:
        mocks.attachStagedSessionRuntimeProvisioning,
      completeSessionRuntimeHostRecovery:
        mocks.completeSessionRuntimeHostRecovery,
      listSessionEvents: mocks.listSessionEvents,
      getSessionFileOwner: mocks.getSessionFileOwner,
    },
    teamMailboxDelivery: {
      initialUserEvents: mocks.initialUserEvents,
      requestDeliveryAfterRuntimePublished:
        mocks.requestDeliveryAfterRuntimePublished,
    },
    capabilityBundles: { flattenBundles: mocks.flattenBundles },
    workflowMcpSessionTokenSigner: { sign: mocks.signSessionToken },
    sessionCommands: {
      cleanupUnpublishedRuntimeProvisioning:
        mocks.cleanupUnpublishedRuntimeProvisioning,
    },
    sessionRuntimeHostRecovery: {},
  }),
}));

vi.mock("$lib/server/dapr-client", () => ({
  daprFetch: (...args: unknown[]) => mocks.daprFetch(...args),
}));

vi.mock("$lib/server/teams/mcp-wiring", () => ({
  deriveLeadTeamId: (sessionId: string) => `team-${sessionId}`,
  ensureTeamMcpServer: (servers: unknown) => servers,
  stampTeamMcpHeaders: (servers: unknown) => servers,
}));

vi.mock("$lib/server/teams/team-repo", () => ({
  getMemberBySession: vi.fn(async () => null),
}));

vi.mock("$lib/server/agents/mcp-sidecar", () => ({
  rewriteMcpForBrowserSidecar: vi.fn(() => ({
    mcpServers: [],
    useBrowserSidecar: false,
  })),
}));

vi.mock("$lib/server/agents/mcp-resolution-application", () => ({
  resolveAgentConfigMcpForProject: (...args: unknown[]) =>
    mocks.resolveAgentConfigMcpForProject(...args),
}));

vi.mock("$lib/server/agents/runtime-routing", () => ({
  agentRuntimeInvokeTarget: (appId: string) => appId,
  resolveAgentRuntimeRoute: (...args: unknown[]) =>
    mocks.resolveAgentRuntimeRoute(...args),
}));

vi.mock("$lib/server/sessions/agent-workflow-host", () => ({
  maybeProvisionAgentWorkflowHost: (...args: unknown[]) =>
    mocks.maybeProvisionAgentWorkflowHost(...args),
  recreateAgentWorkflowHostGeneration: (...args: unknown[]) =>
    mocks.recreateAgentWorkflowHostGeneration(...args),
  waitForAgentWorkflowHostAppReady: (...args: unknown[]) =>
    mocks.waitForAgentWorkflowHostAppReady(...args),
}));

vi.mock("$lib/server/sessions/runtime-host-recovery", () => ({
  ensurePublishedAgentWorkflowHostGeneration: (...args: unknown[]) =>
    mocks.ensurePublishedAgentWorkflowHostGeneration(...args),
}));

vi.mock("$lib/server/sessions/runtime-target", () => ({
  resolveSessionRuntimeTarget: vi.fn(),
  runtimeUsesSharedWorkspace: vi.fn(() => false),
}));

vi.mock("$lib/server/agents/runtime-registry", () => ({
  getRuntimeDescriptor: (...args: unknown[]) =>
    mocks.getRuntimeDescriptor(...args),
}));

vi.mock("$lib/server/agents/swap-safety", () => ({
  evaluateSwap: (...args: unknown[]) => mocks.evaluateSwap(...args),
}));

vi.mock("$lib/server/lifecycle/resolvers", () => ({
  sessionRuntimeGenerationInstanceId: vi.fn(
    () => "session-runtime-generation-1",
  ),
}));

import { spawnSessionWorkflow } from "$lib/server/sessions/spawn";

const STARTED_AT = new Date("2026-07-21T20:00:00.000Z");
const RUNTIME_APP_ID = "agent-session-generation-1";
const RUNTIME_SANDBOX_NAME = "agent-host-agent-session-generation-1";

describe("session runtime generation spawn", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getSessionDetail.mockResolvedValue(session());
    mocks.resolveSessionAgent.mockResolvedValue(agent());
    mocks.reserveSessionRuntimeProvisioning.mockResolvedValue({
      startedAt: STARTED_AT,
    });
    mocks.releaseSessionRuntimeProvisioning.mockResolvedValue(true);
    mocks.stageSessionRuntimeProvisioning.mockResolvedValue(true);
    mocks.attachStagedSessionRuntimeProvisioning.mockResolvedValue(true);
    mocks.completeSessionRuntimeHostRecovery.mockResolvedValue("completed");
    mocks.listSessionEvents.mockResolvedValue([]);
    mocks.getSessionFileOwner.mockResolvedValue({
      userId: "user-1",
      projectId: "project-1",
    });
    mocks.initialUserEvents.mockReturnValue([]);
    mocks.requestDeliveryAfterRuntimePublished.mockResolvedValue(undefined);
    mocks.flattenBundles.mockImplementation(async (config) => config);
    mocks.signSessionToken.mockReturnValue("signed-session-token");
    mocks.cleanupUnpublishedRuntimeProvisioning.mockResolvedValue(true);
    mocks.resolveAgentConfigMcpForProject.mockImplementation(
      async (config) => config,
    );
    mocks.resolveAgentRuntimeRoute.mockReturnValue({
      appId: RUNTIME_APP_ID,
      slug: "dapr-agent-py",
      runtimeClass: "dapr-agent-py",
      isolation: "session",
    });
    mocks.maybeProvisionAgentWorkflowHost.mockResolvedValue({
      agentAppId: RUNTIME_APP_ID,
      sandboxName: RUNTIME_SANDBOX_NAME,
      launchSpec: { version: 1 },
    });
    mocks.recreateAgentWorkflowHostGeneration.mockResolvedValue(undefined);
    mocks.waitForAgentWorkflowHostAppReady.mockResolvedValue({
      baseUrl: "http://runtime-host",
    });
    mocks.ensurePublishedAgentWorkflowHostGeneration.mockResolvedValue({
      recovered: false,
    });
    mocks.getRuntimeDescriptor.mockReturnValue({
      id: "dapr-agent-py",
      family: "dapr-agent",
      capabilities: { interactiveTerminal: false },
    });
    mocks.evaluateSwap.mockReturnValue({ decision: "allow", drops: [] });
  });

  it("adopts a published generation while status is still rescheduling", async () => {
    mocks.getSessionDetail.mockResolvedValue(
      session({
        daprInstanceId: "published-instance",
        natsSubject: "session.events.session-1",
        runtimeAppId: RUNTIME_APP_ID,
        runtimeSandboxName: RUNTIME_SANDBOX_NAME,
      }),
    );

    await expect(spawnSessionWorkflow("session-1")).resolves.toEqual({
      instanceId: "published-instance",
      natsSubject: "session.events.session-1",
    });
    expect(
      mocks.ensurePublishedAgentWorkflowHostGeneration,
    ).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: "session-1",
        runtimeAppId: RUNTIME_APP_ID,
        runtimeSandboxName: RUNTIME_SANDBOX_NAME,
      }),
    );
    expect(mocks.reserveSessionRuntimeProvisioning).not.toHaveBeenCalled();
    expect(mocks.maybeProvisionAgentWorkflowHost).not.toHaveBeenCalled();
    expect(mocks.stageSessionRuntimeProvisioning).not.toHaveBeenCalled();
    expect(mocks.daprFetch).not.toHaveBeenCalled();
  });

  it("releases a supplied lease when replay adopts a published generation", async () => {
    mocks.getSessionDetail.mockResolvedValue(
      session({
        daprInstanceId: "published-instance",
        natsSubject: "session.events.session-1",
        runtimeAppId: RUNTIME_APP_ID,
        runtimeSandboxName: RUNTIME_SANDBOX_NAME,
      }),
    );

    await expect(
      spawnSessionWorkflow("session-1", {
        provisioningLease: { startedAt: STARTED_AT },
      }),
    ).resolves.toEqual({
      instanceId: "published-instance",
      natsSubject: "session.events.session-1",
    });
    expect(mocks.releaseSessionRuntimeProvisioning).toHaveBeenCalledWith({
      sessionId: "session-1",
      expectedStartedAt: STARTED_AT,
    });
    expect(mocks.reserveSessionRuntimeProvisioning).not.toHaveBeenCalled();
    expect(mocks.maybeProvisionAgentWorkflowHost).not.toHaveBeenCalled();
    expect(mocks.stageSessionRuntimeProvisioning).not.toHaveBeenCalled();
    expect(mocks.daprFetch).not.toHaveBeenCalled();
  });

  it("still provisions a genuinely unstarted rescheduling session", async () => {
    mocks.reserveSessionRuntimeProvisioning.mockResolvedValueOnce(null);

    await expect(spawnSessionWorkflow("session-1")).rejects.toThrow(
      "Session session-1 is stopping or terminal",
    );
    expect(mocks.reserveSessionRuntimeProvisioning).toHaveBeenCalledWith({
      sessionId: "session-1",
    });
  });

  it("requires exact lease authority before bypassing published adoption", async () => {
    mocks.getSessionDetail.mockResolvedValueOnce(
      session({ daprInstanceId: "published-instance" }),
    );

    await expect(
      spawnSessionWorkflow("session-1", {
        stagedRuntimeTarget: stagedTarget(),
      }),
    ).rejects.toThrow(
      "staged runtime target requires its exact provisioning lease",
    );
    expect(mocks.reserveSessionRuntimeProvisioning).not.toHaveBeenCalled();
    expect(mocks.maybeProvisionAgentWorkflowHost).not.toHaveBeenCalled();
  });

  it("retains the exact staged target after an ambiguous post-dispatch error", async () => {
    let runtimeAcceptedStart = false;
    mocks.daprFetch.mockImplementationOnce(async () => {
      runtimeAcceptedStart = true;
      throw new Error("socket reset after StartInstance");
    });

    await expect(
      spawnSessionWorkflow("session-1", {
        provisioningLease: { startedAt: STARTED_AT },
      }),
    ).rejects.toThrow("socket reset after StartInstance");

    expect(runtimeAcceptedStart).toBe(true);
    expect(mocks.stageSessionRuntimeProvisioning).toHaveBeenCalledWith({
      sessionId: "session-1",
      expectedStartedAt: STARTED_AT,
      runtimeAppId: RUNTIME_APP_ID,
      durableInstanceId: "session-runtime-generation-1",
      runtimeSandboxName: RUNTIME_SANDBOX_NAME,
      runtimeHostOwned: true,
      runtimeHostLaunchSpec: { version: 1 },
    });
    expect(mocks.cleanupUnpublishedRuntimeProvisioning).not.toHaveBeenCalled();
    expect(mocks.attachStagedSessionRuntimeProvisioning).not.toHaveBeenCalled();
    expect(mocks.completeSessionRuntimeHostRecovery).not.toHaveBeenCalled();
  });

  it("cleans a staged host after a definite runtime rejection", async () => {
    mocks.daprFetch.mockResolvedValueOnce(
      new Response("runtime rejected start", { status: 503 }),
    );

    await expect(
      spawnSessionWorkflow("session-1", {
        provisioningLease: { startedAt: STARTED_AT },
      }),
    ).rejects.toThrow("Dapr workflow start failed (503)");

    expect(mocks.cleanupUnpublishedRuntimeProvisioning).toHaveBeenCalledWith({
      sessionId: "session-1",
      sandboxName: RUNTIME_SANDBOX_NAME,
      leaseStartedAt: STARTED_AT,
      preserveActiveLease: false,
    });
  });

  it("preserves redrive authority when exact-host activation fails", async () => {
    mocks.getSessionDetail.mockResolvedValueOnce(
      session({
        daprInstanceId: "session-runtime-generation-1",
        runtimeAppId: RUNTIME_APP_ID,
        runtimeSandboxName: RUNTIME_SANDBOX_NAME,
      }),
    );
    mocks.daprFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    mocks.ensurePublishedAgentWorkflowHostGeneration.mockRejectedValueOnce(
      new Error("runtime host activation unavailable"),
    );

    await expect(
      spawnSessionWorkflow("session-1", {
        provisioningLease: { startedAt: STARTED_AT },
        preserveStagedLeaseOnFailure: true,
        stagedRuntimeTarget: stagedTarget(),
      }),
    ).rejects.toThrow("runtime host activation unavailable");

    expect(mocks.attachStagedSessionRuntimeProvisioning).toHaveBeenCalledWith({
      sessionId: "session-1",
      expectedStartedAt: STARTED_AT,
    });
    expect(mocks.maybeProvisionAgentWorkflowHost).not.toHaveBeenCalled();
    expect(mocks.recreateAgentWorkflowHostGeneration).toHaveBeenCalledWith({
      agentAppId: RUNTIME_APP_ID,
      sandboxName: RUNTIME_SANDBOX_NAME,
      launchSpec: exactLaunchSpec(),
      sessionSecretEnv: null,
    });
    expect(mocks.stageSessionRuntimeProvisioning).toHaveBeenCalledWith({
      sessionId: "session-1",
      expectedStartedAt: STARTED_AT,
      runtimeAppId: RUNTIME_APP_ID,
      durableInstanceId: "session-runtime-generation-1",
      runtimeSandboxName: RUNTIME_SANDBOX_NAME,
      runtimeHostOwned: true,
      runtimeHostLaunchSpec: exactLaunchSpec(),
    });
    expect(mocks.completeSessionRuntimeHostRecovery).not.toHaveBeenCalled();
    expect(mocks.cleanupUnpublishedRuntimeProvisioning).toHaveBeenCalledWith({
      sessionId: "session-1",
      sandboxName: RUNTIME_SANDBOX_NAME,
      leaseStartedAt: STARTED_AT,
      durableInstance: {
        runtimeAppId: RUNTIME_APP_ID,
        instanceId: "session-runtime-generation-1",
        runtimeSandboxName: RUNTIME_SANDBOX_NAME,
      },
      preserveActiveLease: true,
    });
  });
});

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-1",
    status: "rescheduling",
    completedAt: null,
    daprInstanceId: null,
    natsSubject: null,
    runtimeAppId: null,
    runtimeSandboxName: null,
    agentId: "agent-1",
    agentVersion: 1,
    environmentId: null,
    environmentVersion: null,
    workflowExecutionId: null,
    workspaceSandboxName: null,
    resumedFromSessionId: null,
    vaultIds: [],
    ...overrides,
  };
}

function agent() {
  return {
    id: "agent-1",
    version: 1,
    slug: "agent",
    projectId: null,
    runtime: "dapr-agent-py",
    runtimeAppId: "dapr-agent-py",
    config: {
      runtime: "dapr-agent-py",
      mcpServers: [],
      callableAgents: [],
    },
  };
}

function stagedTarget() {
  return {
    sessionId: "session-1",
    startedAt: STARTED_AT,
    runtimeAppId: RUNTIME_APP_ID,
    durableInstanceId: "session-runtime-generation-1",
    runtimeSandboxName: RUNTIME_SANDBOX_NAME,
    runtimeHostOwned: true,
    runtimeHostLaunchSpec: exactLaunchSpec(),
    publishedGeneration: false,
  };
}

function exactLaunchSpec() {
  return {
    version: 1,
    request: {
      sessionId: "session-1",
      agentAppId: RUNTIME_APP_ID,
    },
    secretEnvKeys: [],
  };
}

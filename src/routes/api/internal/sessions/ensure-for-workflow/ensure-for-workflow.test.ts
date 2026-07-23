import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "$lib/types/agents";
import type { ProvisionWorkflowSessionWorkspaceResult } from "$lib/server/application/session-commands";

const mocks = vi.hoisted(() => {
	const state = {
		inserted: [] as unknown[],
		updates: [] as unknown[],
		hostCalls: [] as unknown[],
		credentials: {} as Record<
			string,
			{ token: string; expiresAt: Date | null }
		>,
	};
  const leaseStartedAt = new Date("2026-07-21T20:00:00.000Z");

	return {
		state,
    leaseStartedAt,
		validateInternalToken: vi.fn(() => true),
    sessionRuntimeHostRecovery: {
      ensurePublished: vi.fn(
        async (): Promise<{
          recovered: boolean;
          readiness: "ready" | "not_ready";
        }> => ({
          recovered: false,
          readiness: "ready",
        }),
      ),
    },
		maybeProvisionAgentWorkflowHost: vi.fn(async (params: unknown) => {
			state.hostCalls.push(params);
			return {
				agentAppId: "agent-session-test",
				sandboxName: "sandbox-test",
				status: "ready",
        launchSpec: { version: 1, request: {}, secretEnvKeys: [] },
			};
		}),
		workflowData: {
			getWorkflowByRef: vi.fn(
				async (): Promise<Record<string, unknown> | null> => null,
			),
      getSessionDetail: vi.fn(
        async (): Promise<Record<string, unknown> | null> => null,
      ),
      getSessionFileOwner: vi.fn(async () => ({
        id: "session-test",
        userId: "user-1",
        projectId: "project-1",
        status: "rescheduling" as const,
        completedAt: null,
        stopRequestedAt: null,
      })),
      getWorkflowExecutionSessionOwnerContext: vi.fn(
        async (): Promise<{
          userId: string;
          workflowId: string;
          projectId: string | null;
          status?: string | null;
          stopRequestedAt?: Date | null;
        } | null> => null,
      ),
			checkBenchmarkSessionProvisioningGate: vi.fn(async () => ({
				ok: true,
				benchmarkExecutionClass: "benchmark-class",
			})),
			getWorkflowAgentRuntimeIdentity: vi.fn(async (agentId: string) => {
				const slug =
					agentId === "agent-published" ? "published-agent" : "test-agent";
				return {
					agentId,
					slug,
					runtimeAppId: `agent-runtime-${slug}`,
					appId: `agent-runtime-${slug}`,
				};
			}),
			resolvePublishedWorkflowAgentForEnsure: vi.fn(
				async (input: {
					agentId: string | null;
					agentVersion?: number | null;
					projectId?: string | null;
				}) => {
					if (!input.agentId) return null;
					return {
						ok: true as const,
						agent: {
							agentId: input.agentId,
							agentVersion: input.agentVersion ?? 3,
							agentSlug: "published-agent",
							agentAppId: "agent-runtime-published-agent",
							mlflowUri: "models:/published-agent/3",
							mlflowModelName: "published-agent",
							mlflowModelVersion: "model-3",
						},
					};
				},
			),
			getWorkflowEnsureSession: vi.fn(
				async (): Promise<{
					id: string;
					agentId: string;
					agentVersion: number;
          userId: string;
          projectId: string | null;
					workflowExecutionId: string | null;
          parentExecutionId: string | null;
					vaultIds: unknown[];
					sandboxName: string | null;
          runtimeAppId?: string | null;
					runtimeSandboxName: string | null;
				} | null> => null,
			),
      createWorkflowEnsureSession: vi.fn(
        async (input: unknown): Promise<{ startedAt: Date } | false> => {
				state.inserted.push(input);
          return { startedAt: leaseStartedAt };
        },
      ),
      reserveSessionRuntimeProvisioning: vi.fn(
        async (): Promise<{ startedAt: Date } | null> => ({
          startedAt: leaseStartedAt,
			}),
      ),
			updateWorkflowEnsureSessionRuntime: vi.fn(async (input: unknown) => {
				state.updates.push(input);
        return true;
			}),
			resolveSessionAgentByRef: vi.fn(
        async (input: {
          id?: string;
          version?: number;
        }): Promise<{
          id?: string;
          name?: string;
          slug?: string;
          version?: number;
					config: Record<string, unknown>;
					projectId: string | null;
          runtime?: string;
          runtimeAppId?: string | null;
          mlflowModelVersion?: string | null;
          mlflowModelName?: string | null;
          mlflowUri?: string | null;
        } | null> => ({
          id: input.id ?? "agent-test",
          name: "Published agent",
          slug:
            input.id === "agent-published" ? "published-agent" : "test-agent",
          version: input.version ?? 3,
          config: {
            runtime:
              input.id === "agent-published"
                ? "codex-cli"
                : "pydantic-ai-agent-py",
            modelSpec:
              input.id === "agent-published"
                ? "openai/gpt-5.5"
                : "kimi/kimi-k3",
            builtinTools: [],
            mcpConnectionMode: "explicit",
            mcpServers: [],
            skills: [],
            runtimeOverridePolicy: {
              allowToolNarrowing: true,
              allowServerAdditions: false,
              allowCredentialBinding: true,
              allowSkillAdditions: false,
              allowSkillNarrowing: true,
            },
          },
          projectId: "project-1",
          runtime:
            input.id === "agent-published"
              ? "codex-cli"
              : "pydantic-ai-agent-py",
          runtimeAppId: null,
          mlflowModelVersion: `model-${input.version ?? 3}`,
          mlflowModelName:
            input.id === "agent-published" ? "published-agent" : "test-agent",
          mlflowUri: `models:/${input.id === "agent-published" ? "published-agent" : "test-agent"}/${input.version ?? 3}`,
        }),
			),
		},
		teamStore: {
			resolveAgentIdBySlug: vi.fn(
				async (): Promise<{ id: string } | null> => null,
			),
		},
		capabilityBundles: {
			flattenBundles: vi.fn(async (config: unknown) => config),
		},
		runtimeRegistry: {
			getStructuredOutputCapability: vi.fn(async (runtimeId: string) =>
        runtimeId === "dapr-agent-py" || runtimeId === "pydantic-ai-agent-py"
					? { mode: "tool" as const, jsonSchemaDraft: "2020-12" as const }
					: null,
			),
		},
		sessionGoals: {
			ensureWorkflowEvaluatorGoal: vi.fn(async () => ({ status: "created" })),
		},
		cliCredentials: {
			needsBootLease: vi.fn(() => false),
			acquireBootLease: vi.fn(async () => true),
			getUserCredential: vi.fn(async (_userId: string, provider: string) => {
				return state.credentials[provider] ?? null;
			}),
		},
		sessionCommands: {
      compensateStoppedRuntimeProvisioning: vi.fn(async () => true),
      cleanupUnpublishedRuntimeProvisioning: vi.fn(async () => true),
      provisionWorkflowSessionWorkspace: vi.fn(
        async (): Promise<ProvisionWorkflowSessionWorkspaceResult> => ({
          status: "ready",
          sandboxName: "openshell-test",
          workspaceRef: "workspace/ws-test",
          rootPath: "/sandbox",
        }),
      ),
			materializeWorkflowSessionRepositories: vi.fn(async () => undefined),
			reapTerminatedWorkflowSessionRuntimeHosts: vi.fn(async () => undefined),
			appendWorkflowSessionSwapDegradedEvent: vi.fn(async () => undefined),
			appendWorkflowSessionInitialMessage: vi.fn(async () => undefined),
			resolveWorkflowSessionAgent: vi.fn(
				async (input: {
					publishedAgent: { agentId: string; agentVersion: number } | null;
					agentConfig?: AgentConfig;
				}) =>
					input.publishedAgent
						? {
								agentId: input.publishedAgent.agentId,
								agentVersion: input.publishedAgent.agentVersion,
							}
						: { agentId: "agent-test", agentVersion: 4 },
			),
			syncWorkflowSessionAgentRuntime: vi.fn(async () => undefined),
		},
		promptStackCompiler: {
			compilePromptStack: vi.fn(async () => ({
				static: [],
				dynamic: [],
				staticManifest: [],
				dynamicManifest: [],
			})),
		},
		workflowTargetAuth: {
			mintAssertion: vi.fn(async () => "wfb_browser_auth_v1.signed.proof"),
		},
    workflowMcpSessionTokenSigner: {
      sign: vi.fn(() => "signed-workflow-mcp-session"),
    },
	};
});

vi.mock("$lib/server/internal-auth", () => ({
	validateInternalToken: mocks.validateInternalToken,
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowData: mocks.workflowData,
		sessionGoals: mocks.sessionGoals,
		cliCredentials: mocks.cliCredentials,
		sessionCommands: mocks.sessionCommands,
    sessionRuntimeHostRecovery: mocks.sessionRuntimeHostRecovery,
		promptStackCompiler: mocks.promptStackCompiler,
		workflowTargetAuth: mocks.workflowTargetAuth,
    workflowMcpSessionTokenSigner: mocks.workflowMcpSessionTokenSigner,
		teamStore: mocks.teamStore,
		capabilityBundles: mocks.capabilityBundles,
		runtimeRegistry: mocks.runtimeRegistry,
	}),
}));

vi.mock("$lib/server/sessions/agent-workflow-host", () => ({
	extractTraceContext: () => ({
		traceparent: null,
		tracestate: null,
		baggage: null,
	}),
	maybeProvisionAgentWorkflowHost: mocks.maybeProvisionAgentWorkflowHost,
  sessionHostAppId: (sessionId: string) => `agent-session-${sessionId}`,
}));

vi.mock("$lib/server/sandboxes/provision", () => ({
	provisionSessionSandboxWithRetry: vi.fn(async () => ({
		sandboxName: "openshell-test",
		workspaceRef: "workspace/ws-test",
	})),
	sandboxProvisionFailureMessage: vi.fn((err: unknown) =>
		err instanceof Error ? err.message : String(err),
	),
}));

import { POST } from "./+server";

const RUNTIME_POLICY = {
	allowToolNarrowing: true,
	allowServerAdditions: false,
	allowCredentialBinding: true,
	allowSkillAdditions: false,
	allowSkillNarrowing: true,
};

function agentConfig(
	runtime: AgentConfig["runtime"],
	modelSpec: string,
): AgentConfig {
	return {
		runtime,
		// Deliberately wrong. The bridge must stamp from the runtime descriptor,
		// not trust user input or stored stale config.
		cliAdapter: "claude-code",
		modelSpec,
		builtinTools: [],
		mcpConnectionMode: "explicit",
		mcpServers: [],
		skills: [],
		runtimeOverridePolicy: RUNTIME_POLICY,
	};
}

function expectSourceCall(
  source: string,
  objectName: string,
  methodName: string,
) {
	expect(source).toMatch(new RegExp(`${objectName}\\s*\\.\\s*${methodName}`));
}

async function callEnsureForWorkflow(params: {
	runtime: AgentConfig["runtime"];
	modelSpec: string;
	provider: string;
	token: string;
	body?: Record<string, unknown>;
}) {
	mocks.state.credentials = {
		[params.provider]: { token: params.token, expiresAt: null },
	};
	const body = {
		sessionId: `sess-${params.runtime}`,
		workflowId: "wf-1",
		nodeId: "run-agent",
		nodeName: "Run agent",
		userId: "user-1",
		projectId: "project-1",
		agentSlug: "test-agent",
		agentConfig: agentConfig(params.runtime, params.modelSpec),
		...params.body,
	};
	const request = new Request("http://workflow-builder/internal", {
		method: "POST",
		headers: { Authorization: "Bearer internal" },
		body: JSON.stringify(body),
	});
	const response = await POST({ request } as never);
	return (await response.json()) as Record<string, unknown>;
}

describe("ensure-for-workflow interactive CLI dispatch", () => {
	beforeEach(() => {
		mocks.state.inserted = [];
		mocks.state.updates = [];
		mocks.state.hostCalls = [];
		mocks.state.credentials = {};
		vi.clearAllMocks();
	});

	it("keeps ensure session row persistence behind workflow-data ports", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expectSourceCall(
			source,
			"workflowData",
			"getWorkflowExecutionSessionOwnerContext",
		);
    expectSourceCall(
      source,
      "workflowData",
      "checkBenchmarkSessionProvisioningGate",
    );
		expectSourceCall(source, "workflowData", "getWorkflowAgentRuntimeIdentity");
    expectSourceCall(
      source,
      "workflowData",
      "resolvePublishedWorkflowAgentForEnsure",
    );
		expectSourceCall(source, "workflowData", "getWorkflowEnsureSession");
    expectSourceCall(source, "workflowData", "getSessionDetail");
    expectSourceCall(source, "workflowData", "getSessionFileOwner");
		expectSourceCall(source, "workflowData", "createWorkflowEnsureSession");
    expectSourceCall(
      source,
      "workflowData",
      "updateWorkflowEnsureSessionRuntime",
    );
		expectSourceCall(source, "sessionGoals", "ensureWorkflowEvaluatorGoal");
		expectSourceCall(
			source,
			"sessionCommands",
			"materializeWorkflowSessionRepositories",
		);
		expectSourceCall(
			source,
			"sessionCommands",
			"reapTerminatedWorkflowSessionRuntimeHosts",
		);
    expectSourceCall(
      source,
      "workflowData",
      "reserveSessionRuntimeProvisioning",
    );
    expectSourceCall(
      source,
      "sessionCommands",
      "cleanupUnpublishedRuntimeProvisioning",
    );
    expectSourceCall(
      source,
      "sessionCommands",
      "provisionWorkflowSessionWorkspace",
    );
		expectSourceCall(
			source,
			"sessionCommands",
			"appendWorkflowSessionInitialMessage",
		);
		expectSourceCall(
			source,
			"sessionCommands",
			"appendWorkflowSessionSwapDegradedEvent",
		);
		expectSourceCall(source, "sessionCommands", "resolveWorkflowSessionAgent");
    expectSourceCall(
      source,
      "sessionCommands",
      "syncWorkflowSessionAgentRuntime",
    );
		expectSourceCall(source, "promptStackCompiler", "compilePromptStack");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/prompt-presets");
		expect(source).not.toContain("$lib/server/agents/ephemeral");
		expect(source).not.toContain("findOrCreateEphemeralAgent");
		expect(source).not.toContain("$lib/server/agents/registry-sync");
		expect(source).not.toContain("syncAgentRuntimeCR");
		expect(source).not.toContain("$lib/server/goals/repo");
		expect(source).not.toContain("$lib/server/sessions/events");
		expect(source).not.toContain("appendEvent");
		expect(source).not.toContain("sendUserEvent");
		expect(source).not.toContain("$lib/server/sessions/registry");
		expect(source).not.toContain("$lib/server/sessions/repositories");
		expect(source).not.toContain("deleteSandbox");
		expect(source).not.toContain("listTerminalWorkflowSessionRuntimeHosts");
		expect(source).not.toContain("addResource");
		expect(source).not.toContain("listResources");
		expect(source).not.toContain("mountSessionRepositories");
		expect(source).not.toContain("createOrReplaceGoal");
		expect(source).not.toContain("getCurrentGoal");
		expect(source).not.toContain("workflowExecutions,");
		expect(source).not.toContain("from(workflowExecutions)");
		expect(source).not.toContain("workflows,");
		expect(source).not.toContain("from(workflows)");
		expect(source).not.toContain("agentVersions");
		expect(source).not.toContain("from(agents)");
		expect(source).not.toContain("from(agentVersions)");
    expect(source).not.toContain("provisionSessionSandbox");
		expect(source).not.toContain("registerAgentVersionInMlflow");
		expect(source).not.toContain("benchmarkRuns");
		expect(source).not.toContain("benchmarkRunInstances");
		expect(source).not.toContain("select({ slug: agents.slug");
		expect(source).not.toContain("db.insert(sessions)");
		expect(source).not.toContain("db.update(sessions)");
		expect(source).not.toContain("from(sessions)");
	});

	it("preserves a call-scoped iteration budget in the runtime child input", async () => {
		const payload = await callEnsureForWorkflow({
			runtime: "pydantic-ai-agent-py",
			modelSpec: "kimi/kimi-k3",
			provider: "kimi",
			token: "kimi-test-token",
			body: {
				maxIterations: 20,
				agentConfig: {
					...agentConfig("pydantic-ai-agent-py", "kimi/kimi-k3"),
					maxTurns: 40,
				},
			},
		});

		expect(
			(payload.childInput as Record<string, unknown>).maxIterations,
		).toBe(20);
	});

  it("destroys a host when stop intent wins the runtime-link CAS", async () => {
    mocks.workflowData.updateWorkflowEnsureSessionRuntime.mockResolvedValueOnce(
      false,
    );
    mocks.state.credentials.kimi = {
      token: "kimi-test-token",
      expiresAt: null,
    };
    const request = new Request("http://workflow-builder/internal", {
      method: "POST",
      headers: { Authorization: "Bearer internal" },
      body: JSON.stringify({
        sessionId: "sess-stop-race",
        workflowId: "wf-1",
        nodeId: "run-agent",
        nodeName: "Run agent",
        userId: "user-1",
        projectId: "project-1",
        agentSlug: "test-agent",
        agentConfig: agentConfig("pydantic-ai-agent-py", "kimi/kimi-k3"),
      }),
    });

    const response = await POST({ request } as never);
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(payload.error).toBe("session_stopping");
    expect(
      mocks.sessionCommands.cleanupUnpublishedRuntimeProvisioning,
    ).toHaveBeenCalledWith({
      sessionId: "sess-stop-race",
      sandboxName: "sandbox-test",
      leaseStartedAt: mocks.leaseStartedAt,
    });
    expect(
      mocks.sessionCommands.materializeWorkflowSessionRepositories,
    ).not.toHaveBeenCalled();
  });

  it("compensates an existing session with its exact reserved lease", async () => {
    mocks.workflowData.getWorkflowEnsureSession.mockResolvedValueOnce({
      id: "sess-existing-stop-race",
      agentId: "agent-test",
      agentVersion: 4,
      userId: "user-1",
      projectId: "project-1",
      workflowExecutionId: null,
      parentExecutionId: null,
      vaultIds: [],
      sandboxName: "dapr-agent-py",
      runtimeSandboxName: null,
    });
    mocks.workflowData.updateWorkflowEnsureSessionRuntime.mockResolvedValueOnce(
      false,
    );
    mocks.state.credentials.kimi = {
      token: "kimi-test-token",
      expiresAt: null,
    };
    const request = new Request("http://workflow-builder/internal", {
      method: "POST",
      headers: { Authorization: "Bearer internal" },
      body: JSON.stringify({
        sessionId: "sess-existing-stop-race",
        workflowId: "wf-1",
        nodeId: "run-agent",
        nodeName: "Run agent",
        userId: "user-1",
        projectId: "project-1",
        agentSlug: "test-agent",
        agentConfig: agentConfig("pydantic-ai-agent-py", "kimi/kimi-k3"),
      }),
    });

    const response = await POST({ request } as never);
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(payload.error).toBe("session_stopping");
    expect(
      mocks.workflowData.reserveSessionRuntimeProvisioning,
    ).toHaveBeenCalledWith({ sessionId: "sess-existing-stop-race" });
    expect(
      mocks.sessionCommands.cleanupUnpublishedRuntimeProvisioning,
    ).toHaveBeenCalledWith({
      sessionId: "sess-existing-stop-race",
      sandboxName: "sandbox-test",
      leaseStartedAt: mocks.leaseStartedAt,
    });
    expect(
      mocks.workflowData.createWorkflowEnsureSession,
    ).not.toHaveBeenCalled();
  });

  it("releases an existing session lease when host provisioning throws", async () => {
    mocks.workflowData.getWorkflowEnsureSession.mockResolvedValueOnce({
      id: "sess-existing-host-failure",
      agentId: "agent-test",
      agentVersion: 4,
      userId: "user-1",
      projectId: "project-1",
      workflowExecutionId: null,
      parentExecutionId: null,
      vaultIds: [],
      sandboxName: "pydantic-ai-agent-py",
      runtimeSandboxName: null,
    });
    mocks.maybeProvisionAgentWorkflowHost.mockRejectedValueOnce(
      new Error("host provisioning failed"),
    );

    await expect(
      callEnsureForWorkflow({
        runtime: "pydantic-ai-agent-py",
        modelSpec: "kimi/kimi-k3",
        provider: "kimi",
        token: "kimi-test-token",
      }),
    ).rejects.toThrow("host provisioning failed");

    expect(
      mocks.sessionCommands.cleanupUnpublishedRuntimeProvisioning,
    ).toHaveBeenCalledWith({
      sessionId: "sess-existing-host-failure",
      sandboxName: null,
      leaseStartedAt: mocks.leaseStartedAt,
    });
    expect(
      mocks.workflowData.updateWorkflowEnsureSessionRuntime,
    ).not.toHaveBeenCalled();
  });

  it("publishes and activates the exact lease generation", async () => {
    await callEnsureForWorkflow({
      runtime: "pydantic-ai-agent-py",
      modelSpec: "kimi/kimi-k3",
      provider: "kimi",
      token: "kimi-test-token",
    });

    expect(mocks.maybeProvisionAgentWorkflowHost).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-pydantic-ai-agent-py",
        provisioningStartedAt: mocks.leaseStartedAt,
      }),
    );
    expect(
      mocks.sessionRuntimeHostRecovery.ensurePublished,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-pydantic-ai-agent-py",
        runtimeAppId: "agent-session-test",
        runtimeSandboxName: "sandbox-test",
      }),
    );
    expect(
      mocks.workflowData.updateWorkflowEnsureSessionRuntime.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      mocks.sessionRuntimeHostRecovery.ensurePublished.mock
        .invocationCallOrder[0],
    );
  });

  it("keeps a newly published host queued until post-activation readiness is proven", async () => {
    mocks.sessionRuntimeHostRecovery.ensurePublished.mockResolvedValueOnce({
      recovered: false,
      readiness: "not_ready",
    });

    const payload = await callEnsureForWorkflow({
      runtime: "pydantic-ai-agent-py",
      modelSpec: "kimi/kimi-k3",
      provider: "kimi",
      token: "kimi-test-token",
    });

    expect(mocks.maybeProvisionAgentWorkflowHost).toHaveBeenCalledOnce();
    expect(payload.agentHostStatus).toBe("queued");
  });

  it("reuses an existing published runtime without reserving a new generation", async () => {
    mocks.workflowData.getWorkflowEnsureSession.mockResolvedValueOnce({
      id: "sess-codex-cli",
      agentId: "agent-existing",
      agentVersion: 7,
      userId: "user-1",
      projectId: "project-1",
      workflowExecutionId: "execution-1",
      parentExecutionId: null,
      vaultIds: [],
      sandboxName: "codex-cli",
      runtimeAppId: "agent-session-persisted",
      runtimeSandboxName: "sandbox-persisted",
    });
    mocks.workflowData.getSessionDetail.mockResolvedValueOnce({
      daprInstanceId: "sess-codex-cli",
      status: "running",
      stopRequestedAt: null,
      completedAt: null,
    });

    const payload = await callEnsureForWorkflow({
      runtime: "codex-cli",
      modelSpec: "openai/gpt-5.5",
      provider: "openai",
      token: '{"tokens":{"refresh_token":"codex"}}',
      body: { workflowExecutionId: "execution-1" },
    });

    expect(
      mocks.workflowData.reserveSessionRuntimeProvisioning,
    ).not.toHaveBeenCalled();
    expect(mocks.maybeProvisionAgentWorkflowHost).not.toHaveBeenCalled();
    expect(
      mocks.sessionRuntimeHostRecovery.ensurePublished,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-codex-cli",
        runtimeAppId: "agent-session-persisted",
        runtimeSandboxName: "sandbox-persisted",
      }),
    );
    expect(
      mocks.workflowData.updateWorkflowEnsureSessionRuntime,
    ).not.toHaveBeenCalled();
    expect(payload.agentAppId).toBe("agent-session-persisted");
    expect(payload.agentHostStatus).toBe("ready");
    expect(payload.runtimeSandboxName).toBe("sandbox-persisted");
    expect(payload.childInput).toEqual(
      expect.objectContaining({
        agentAppId: "agent-session-persisted",
        runtimeSandboxName: "sandbox-persisted",
      }),
    );
    expect(
      mocks.sessionCommands.materializeWorkflowSessionRepositories,
    ).toHaveBeenCalled();
  });

  it("repolls a queued published host and returns ready only after live readiness is proven", async () => {
    mocks.workflowData.getWorkflowEnsureSession
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "sess-pydantic-ai-agent-py",
        agentId: "agent-test",
        agentVersion: 4,
        userId: "user-1",
        projectId: "project-1",
        workflowExecutionId: null,
        parentExecutionId: null,
        vaultIds: [],
        sandboxName: "pydantic-ai-agent-py",
        runtimeAppId: "agent-session-test",
        runtimeSandboxName: "sandbox-test",
      });
    mocks.workflowData.getSessionDetail.mockResolvedValueOnce({
      daprInstanceId: "sess-pydantic-ai-agent-py",
      status: "running",
      stopRequestedAt: null,
      completedAt: null,
    });
    mocks.maybeProvisionAgentWorkflowHost.mockResolvedValueOnce({
      agentAppId: "agent-session-test",
      sandboxName: "sandbox-test",
      status: "queued",
      launchSpec: { version: 1, request: {}, secretEnvKeys: [] },
    });
    mocks.sessionRuntimeHostRecovery.ensurePublished
      .mockResolvedValueOnce({ recovered: false, readiness: "not_ready" })
      .mockResolvedValueOnce({ recovered: false, readiness: "ready" });

    const first = await callEnsureForWorkflow({
      runtime: "pydantic-ai-agent-py",
      modelSpec: "kimi/kimi-k3",
      provider: "kimi",
      token: "kimi-test-token",
    });
    const second = await callEnsureForWorkflow({
      runtime: "pydantic-ai-agent-py",
      modelSpec: "kimi/kimi-k3",
      provider: "kimi",
      token: "kimi-test-token",
    });

    expect(first.agentHostStatus).toBe("queued");
    expect(second.agentHostStatus).toBe("ready");
    expect(mocks.maybeProvisionAgentWorkflowHost).toHaveBeenCalledOnce();
    expect(
      mocks.sessionRuntimeHostRecovery.ensurePublished,
    ).toHaveBeenCalledTimes(2);
  });

  it("returns a retryable queued status while a published host is still not ready", async () => {
    mocks.workflowData.getWorkflowEnsureSession.mockResolvedValueOnce({
      id: "sess-still-cold",
      agentId: "agent-test",
      agentVersion: 4,
      userId: "user-1",
      projectId: "project-1",
      workflowExecutionId: null,
      parentExecutionId: null,
      vaultIds: [],
      sandboxName: "pydantic-ai-agent-py",
      runtimeAppId: "agent-session-still-cold",
      runtimeSandboxName: "sandbox-still-cold",
    });
    mocks.workflowData.getSessionDetail.mockResolvedValueOnce({
      daprInstanceId: "sess-still-cold",
      status: "running",
      stopRequestedAt: null,
      completedAt: null,
    });
    mocks.sessionRuntimeHostRecovery.ensurePublished.mockResolvedValueOnce({
      recovered: false,
      readiness: "not_ready",
    });

    const payload = await callEnsureForWorkflow({
      runtime: "pydantic-ai-agent-py",
      modelSpec: "kimi/kimi-k3",
      provider: "kimi",
      token: "kimi-test-token",
      body: { sessionId: "sess-still-cold" },
    });

    expect(payload.agentHostStatus).toBe("queued");
    expect(mocks.maybeProvisionAgentWorkflowHost).not.toHaveBeenCalled();
  });

  it("repolls a legacy dedicated host whose Sandbox name was not persisted", async () => {
    mocks.workflowData.getWorkflowEnsureSession.mockResolvedValueOnce({
      id: "sess-legacy-host",
      agentId: "agent-test",
      agentVersion: 4,
      userId: "user-1",
      projectId: "project-1",
      workflowExecutionId: null,
      parentExecutionId: null,
      vaultIds: [],
      sandboxName: "pydantic-ai-agent-py",
      runtimeAppId: "agent-session-legacy-host",
      runtimeSandboxName: null,
    });
    mocks.workflowData.getSessionDetail.mockResolvedValueOnce({
      daprInstanceId: "sess-legacy-host",
      status: "running",
      stopRequestedAt: null,
      completedAt: null,
    });
    mocks.sessionRuntimeHostRecovery.ensurePublished.mockResolvedValueOnce({
      recovered: false,
      readiness: "not_ready",
    });

    const payload = await callEnsureForWorkflow({
      runtime: "pydantic-ai-agent-py",
      modelSpec: "kimi/kimi-k3",
      provider: "kimi",
      token: "kimi-test-token",
      body: { sessionId: "sess-legacy-host" },
    });

    expect(mocks.sessionRuntimeHostRecovery.ensurePublished).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-legacy-host",
        runtimeAppId: "agent-session-legacy-host",
        runtimeSandboxName: "agent-host-agent-session-legacy-host",
      }),
    );
    expect(payload.runtimeSandboxName).toBe(
      "agent-host-agent-session-legacy-host",
    );
    expect(payload.agentHostStatus).toBe("queued");
  });

  it("reports an active busy lease as retryable provisioning", async () => {
    mocks.workflowData.getWorkflowEnsureSession.mockResolvedValueOnce({
      id: "sess-busy",
      agentId: "agent-test",
      agentVersion: 4,
      userId: "user-1",
      projectId: "project-1",
      workflowExecutionId: null,
      parentExecutionId: null,
      vaultIds: [],
      sandboxName: "dapr-agent-py",
      runtimeAppId: null,
      runtimeSandboxName: null,
    });
    mocks.workflowData.reserveSessionRuntimeProvisioning.mockResolvedValueOnce(
      null,
    );
    const request = new Request("http://workflow-builder/internal", {
      method: "POST",
      headers: { Authorization: "Bearer internal" },
      body: JSON.stringify({
        sessionId: "sess-busy",
        workflowId: "wf-1",
        nodeId: "run-agent",
        nodeName: "Run agent",
        userId: "user-1",
        projectId: "project-1",
        agentSlug: "test-agent",
        agentConfig: agentConfig("dapr-agent-py", "kimi/kimi-k3"),
      }),
    });

    const response = await POST({ request } as never);
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(payload).toMatchObject({
      error: "session_provisioning",
      retryable: true,
    });
    expect(mocks.maybeProvisionAgentWorkflowHost).not.toHaveBeenCalled();
  });

  it("cleans up a newly provisioned host when runtime publication throws", async () => {
    mocks.workflowData.updateWorkflowEnsureSessionRuntime.mockRejectedValueOnce(
      new Error("runtime publication failed"),
    );

    await expect(
      callEnsureForWorkflow({
        runtime: "pydantic-ai-agent-py",
        modelSpec: "kimi/kimi-k3",
        provider: "kimi",
        token: "kimi-test-token",
      }),
    ).rejects.toThrow("runtime publication failed");

    expect(
      mocks.sessionCommands.cleanupUnpublishedRuntimeProvisioning,
    ).toHaveBeenCalledWith({
      sessionId: "sess-pydantic-ai-agent-py",
      sandboxName: "sandbox-test",
      leaseStartedAt: mocks.leaseStartedAt,
    });
  });

  it("releases a new session lease when goal initialization throws", async () => {
    mocks.sessionGoals.ensureWorkflowEvaluatorGoal.mockRejectedValueOnce(
      new Error("goal initialization failed"),
    );

    await expect(
      callEnsureForWorkflow({
        runtime: "agy-cli",
        modelSpec: "gemini/gemini-2.5-pro",
        provider: "google",
        token: "agy-bundle",
        body: {
          workflowExecutionId: "execution-1",
          goal: { objective: "finish the task" },
        },
      }),
    ).rejects.toThrow("goal initialization failed");

    expect(
      mocks.sessionCommands.cleanupUnpublishedRuntimeProvisioning,
    ).toHaveBeenCalledWith({
      sessionId: "sess-agy-cli",
      sandboxName: null,
      leaseStartedAt: mocks.leaseStartedAt,
    });
    expect(mocks.maybeProvisionAgentWorkflowHost).not.toHaveBeenCalled();
  });

  it("rejects late provisioning after the parent workflow stop fence", async () => {
    mocks.workflowData.getWorkflowExecutionSessionOwnerContext.mockResolvedValueOnce(
      {
        userId: "user-1",
        workflowId: "wf-1",
        projectId: "project-1",
        status: "running",
        stopRequestedAt: new Date("2026-07-21T20:00:00.000Z"),
      },
    );
    const request = new Request("http://workflow-builder/internal", {
      method: "POST",
      headers: { Authorization: "Bearer internal" },
      body: JSON.stringify({
        sessionId: "sess-parent-stop",
        workflowId: "wf-1",
        workflowExecutionId: "exec-stopping",
        nodeId: "run-agent",
        nodeName: "Run agent",
        userId: "user-1",
        projectId: "project-1",
        agentSlug: "test-agent",
        agentConfig: agentConfig("pydantic-ai-agent-py", "kimi/kimi-k3"),
      }),
    });

    let status = 0;
    try {
      await POST({ request } as never);
    } catch (cause) {
      status = (cause as { status?: number }).status ?? 0;
    }

    expect(status).toBe(409);
    expect(mocks.maybeProvisionAgentWorkflowHost).not.toHaveBeenCalled();
    expect(
      mocks.sessionCommands.provisionWorkflowSessionWorkspace,
    ).not.toHaveBeenCalled();
  });

  it("compensates and rejects when stop wins during auto-workspace provisioning", async () => {
    mocks.sessionCommands.provisionWorkflowSessionWorkspace.mockResolvedValueOnce(
      {
        status: "stopping",
      },
    );
    const request = new Request("http://workflow-builder/internal", {
      method: "POST",
      headers: { Authorization: "Bearer internal" },
      body: JSON.stringify({
        sessionId: "sess-workspace-stop-race",
        workflowId: "wf-1",
        workflowExecutionId: "exec-running",
        nodeId: "run-agent",
        nodeName: "Run agent",
        userId: "user-1",
        projectId: "project-1",
        agentSlug: "test-agent",
        agentConfig: agentConfig("dapr-agent-py", "kimi/kimi-k3"),
      }),
    });

    const response = await POST({ request } as never);
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(payload.error).toBe("session_stopping");
    expect(
      mocks.workflowData.createWorkflowEnsureSession,
    ).toHaveBeenCalledOnce();
    expect(
      mocks.sessionCommands.provisionWorkflowSessionWorkspace,
    ).toHaveBeenCalledWith({
      sessionId: "sess-workspace-stop-race",
      title: "Workflow run: run-agent",
      sandboxTemplate: "base",
    });
    expect(
      mocks.sessionCommands.cleanupUnpublishedRuntimeProvisioning,
    ).toHaveBeenCalledWith({
      sessionId: "sess-workspace-stop-race",
      sandboxName: null,
      leaseStartedAt: mocks.leaseStartedAt,
    });
    expect(mocks.maybeProvisionAgentWorkflowHost).not.toHaveBeenCalled();
  });

  it("rejects when the transactional parent fence loses the create race", async () => {
    mocks.workflowData.createWorkflowEnsureSession.mockResolvedValueOnce(false);
    const request = new Request("http://workflow-builder/internal", {
      method: "POST",
      headers: { Authorization: "Bearer internal" },
      body: JSON.stringify({
        sessionId: "sess-parent-stop-race",
        workflowId: "wf-1",
        workflowExecutionId: "exec-stopping",
        nodeId: "run-agent",
        nodeName: "Run agent",
        userId: "user-1",
        projectId: "project-1",
        agentSlug: "test-agent",
        agentConfig: agentConfig("pydantic-ai-agent-py", "kimi/kimi-k3"),
      }),
    });

    let status = 0;
    try {
      await POST({ request } as never);
    } catch (cause) {
      status = (cause as { status?: number }).status ?? 0;
    }

    expect(status).toBe(409);
    expect(mocks.maybeProvisionAgentWorkflowHost).not.toHaveBeenCalled();
  });

	it("uses published agent resolution from workflow-data when provided", async () => {
		const payload = await callEnsureForWorkflow({
			runtime: "codex-cli",
			modelSpec: "openai/gpt-5.5",
			provider: "openai",
			token: '{"tokens":{"refresh_token":"codex"}}',
			body: {
				agentId: "agent-published",
				agentVersion: 9,
				agentSlug: "published-agent",
			},
		});

		expect(
			mocks.workflowData.resolvePublishedWorkflowAgentForEnsure,
		).toHaveBeenCalledWith({
			agentId: "agent-published",
			agentVersion: 9,
			projectId: "project-1",
		});
		expect(
			mocks.sessionCommands.resolveWorkflowSessionAgent,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				publishedAgent: expect.objectContaining({
					agentId: "agent-published",
					agentVersion: 9,
				}),
				workflowId: "wf-1",
				nodeId: "run-agent",
				agentConfig: expect.objectContaining({
					runtime: "codex-cli",
					cliAdapter: "codex",
				}),
				userId: "user-1",
			}),
		);
		expect(
			mocks.sessionCommands.syncWorkflowSessionAgentRuntime,
		).toHaveBeenCalledWith({ agentId: "agent-published" });
		expect(payload.agentId).toBe("agent-published");
		expect(payload.agentVersion).toBe(9);
		expect(payload.agentSlug).toBe("published-agent");
		expect(payload.agentAppId).toBe("agent-session-test");

		const childInput = payload.childInput as Record<string, unknown>;
    expect(childInput.requiresStartAuthority).toBe(true);
    expect(childInput.workflowMcpSessionToken).toBe(
      "signed-workflow-mcp-session",
    );
		expect(childInput.agentId).toBe("agent-published");
		expect(childInput.agentVersion).toBe(9);
		expect(childInput.agentSlug).toBe("published-agent");
    expect(childInput.activeModelId).toBe("model-9");
		expect(childInput.activeModelName).toBe("published-agent");
    expect(childInput.activeModelUri).toBe("models:/published-agent/9");
	});

	it("falls back to ephemeral workflow agents when no published agent id is supplied", async () => {
		await callEnsureForWorkflow({
			runtime: "codex-cli",
			modelSpec: "openai/gpt-5.5",
			provider: "openai",
			token: '{"tokens":{"refresh_token":"codex"}}',
		});

		expect(
			mocks.workflowData.resolvePublishedWorkflowAgentForEnsure,
		).toHaveBeenCalledWith({
			agentId: null,
			agentVersion: null,
			projectId: "project-1",
		});
		expect(
			mocks.sessionCommands.resolveWorkflowSessionAgent,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				publishedAgent: null,
				workflowId: "wf-1",
				nodeId: "run-agent",
				agentConfig: expect.objectContaining({
					runtime: "codex-cli",
					cliAdapter: "codex",
				}),
				userId: "user-1",
			}),
		);
		expect(
			mocks.sessionCommands.syncWorkflowSessionAgentRuntime,
		).toHaveBeenCalledWith({ agentId: "agent-test" });
	});

	it("best-effort syncs the runtime when replay returns an existing session", async () => {
		mocks.workflowData.getWorkflowEnsureSession.mockResolvedValueOnce({
			id: "sess-codex-cli",
			agentId: "agent-existing",
			agentVersion: 7,
      userId: "user-1",
      projectId: "project-1",
			workflowExecutionId: "execution-1",
      parentExecutionId: null,
			vaultIds: [],
			sandboxName: "codex-cli",
			runtimeSandboxName: null,
		});

		const payload = await callEnsureForWorkflow({
			runtime: "codex-cli",
			modelSpec: "openai/gpt-5.5",
			provider: "openai",
			token: '{"tokens":{"refresh_token":"codex"}}',
			body: { workflowExecutionId: "execution-1" },
		});

		expect(
			mocks.sessionCommands.syncWorkflowSessionAgentRuntime,
		).toHaveBeenCalledWith({
			agentId: "agent-existing",
			bestEffort: true,
			context: "existing session sess-codex-cli",
		});
		expect(
			mocks.sessionCommands.resolveWorkflowSessionAgent,
		).not.toHaveBeenCalled();
		expect(payload.reused).toBe(true);
		expect(payload.agentId).toBe("agent-existing");
		expect(payload.agentVersion).toBe(7);
	});

  it("replays a lost response from the exact saved-agent version after latest advances", async () => {
    mocks.workflowData.getWorkflowEnsureSession.mockResolvedValueOnce({
      id: "sess-codex-cli",
      agentId: "agent-pinned",
      agentVersion: 7,
      userId: "user-1",
      projectId: "project-1",
      workflowExecutionId: "execution-1",
      parentExecutionId: null,
      vaultIds: [],
      sandboxName: "pydantic-ai-agent-py",
      runtimeAppId: null,
      runtimeSandboxName: null,
    });
    mocks.workflowData.resolveSessionAgentByRef.mockResolvedValueOnce({
      id: "agent-pinned",
      name: "Pinned agent",
      slug: "pinned-agent",
      version: 7,
      config: {
        runtime: "pydantic-ai-agent-py",
        modelSpec: "kimi/kimi-k3",
        reasoningEffort: "max",
        builtinTools: [],
        mcpConnectionMode: "explicit",
        mcpServers: [],
        skills: [],
        runtimeOverridePolicy: RUNTIME_POLICY,
      },
      projectId: "project-1",
      runtime: "pydantic-ai-agent-py",
      runtimeAppId: "agent-runtime-pinned-agent",
      mlflowModelVersion: "model-7",
      mlflowModelName: "pinned-agent",
      mlflowUri: "models:/pinned-agent/7",
    });
    // This is what an unpinned retry would resolve after the agent's latest
    // version advanced. The existing row must bypass this lookup entirely.
    mocks.teamStore.resolveAgentIdBySlug.mockResolvedValue({
      id: "agent-pinned",
    });

    const payload = await callEnsureForWorkflow({
      runtime: "codex-cli",
      modelSpec: "openai/gpt-5.5",
      provider: "openai",
      token: '{"tokens":{"refresh_token":"codex"}}',
      body: {
        workflowExecutionId: "execution-1",
        resolveAgentSlug: "pinned-agent",
        agentId: "agent-pinned",
        agentSlug: "pinned-agent",
      },
    });

    expect(mocks.teamStore.resolveAgentIdBySlug).not.toHaveBeenCalled();
    expect(
      mocks.workflowData.resolvePublishedWorkflowAgentForEnsure,
    ).not.toHaveBeenCalled();
    expect(mocks.workflowData.resolveSessionAgentByRef).toHaveBeenCalledWith({
      id: "agent-pinned",
      version: 7,
    });
    expect(mocks.maybeProvisionAgentWorkflowHost).toHaveBeenCalledWith(
      expect.objectContaining({
        agentConfig: expect.objectContaining({
          runtime: "pydantic-ai-agent-py",
          modelSpec: "openai/gpt-5.5",
          reasoningEffort: "max",
        }),
      }),
    );
    expect(payload).toMatchObject({
      reused: true,
      agentId: "agent-pinned",
      agentVersion: 7,
      agentSlug: "pinned-agent",
    });
    expect(payload.childInput).toEqual(
      expect.objectContaining({
        agentId: "agent-pinned",
        agentVersion: 7,
        agentSlug: "pinned-agent",
        activeModelId: "model-7",
        activeModelName: "pinned-agent",
        activeModelUri: "models:/pinned-agent/7",
        agentConfig: expect.objectContaining({
          runtime: "pydantic-ai-agent-py",
          modelSpec: "openai/gpt-5.5",
          reasoningEffort: "max",
        }),
      }),
    );
  });

  it("fails closed when the saved-agent resolver does not return the pinned version", async () => {
    mocks.workflowData.getWorkflowEnsureSession.mockResolvedValueOnce({
      id: "sess-codex-cli",
      agentId: "agent-pinned",
      agentVersion: 7,
      userId: "user-1",
      projectId: "project-1",
      workflowExecutionId: "execution-1",
      parentExecutionId: null,
      vaultIds: [],
      sandboxName: "codex-cli",
      runtimeAppId: null,
      runtimeSandboxName: null,
    });
    mocks.workflowData.resolveSessionAgentByRef.mockResolvedValueOnce({
      id: "agent-pinned",
      name: "Wrong version",
      slug: "published-agent",
      version: 8,
      config: agentConfig("codex-cli", "openai/gpt-5.5"),
      projectId: "project-1",
      runtime: "codex-cli",
      runtimeAppId: null,
      mlflowModelVersion: "model-8",
      mlflowModelName: "published-agent",
      mlflowUri: "models:/published-agent/8",
    });

    await expect(
      callEnsureForWorkflow({
        runtime: "codex-cli",
        modelSpec: "openai/gpt-5.5",
        provider: "openai",
        token: '{"tokens":{"refresh_token":"codex"}}',
        body: { workflowExecutionId: "execution-1" },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(mocks.maybeProvisionAgentWorkflowHost).not.toHaveBeenCalled();
    expect(
      mocks.sessionCommands.syncWorkflowSessionAgentRuntime,
    ).not.toHaveBeenCalled();
  });

  it("replays an archived pinned version without requiring published metadata", async () => {
    mocks.workflowData.getWorkflowEnsureSession.mockResolvedValueOnce({
      id: "sess-codex-cli",
      agentId: "agent-archived",
      agentVersion: 5,
      userId: "user-1",
      projectId: "project-1",
      workflowExecutionId: null,
      parentExecutionId: null,
      vaultIds: [],
      sandboxName: "pydantic-ai-agent-py",
      runtimeAppId: null,
      runtimeSandboxName: null,
    });
    mocks.workflowData.resolveSessionAgentByRef.mockResolvedValueOnce({
      id: "agent-archived",
      name: "Archived agent",
      slug: "archived-agent",
      version: 5,
      config: agentConfig("pydantic-ai-agent-py", "kimi/kimi-k3"),
      projectId: "project-1",
      runtime: "pydantic-ai-agent-py",
      runtimeAppId: "agent-runtime-archived-agent",
      mlflowModelVersion: "archived-model-5",
      mlflowModelName: "archived-agent",
      mlflowUri: "models:/archived-agent/5",
    });

    const payload = await callEnsureForWorkflow({
      runtime: "pydantic-ai-agent-py",
      modelSpec: "kimi/kimi-k3",
      provider: "kimi",
      token: "kimi-test-token",
      body: {
        agentId: "agent-archived",
        agentVersion: 5,
        agentSlug: "archived-agent",
      },
    });

    expect(
      mocks.workflowData.resolvePublishedWorkflowAgentForEnsure,
    ).not.toHaveBeenCalled();
    expect(payload).toMatchObject({
      reused: true,
      agentId: "agent-archived",
      agentVersion: 5,
      agentSlug: "archived-agent",
    });
    expect(payload.childInput).toEqual(
      expect.objectContaining({
        activeModelId: "archived-model-5",
        activeModelName: "archived-agent",
        activeModelUri: "models:/archived-agent/5",
      }),
    );
  });

  it("builds identical exact saved config before and after a lost response", async () => {
    const savedAgent = {
      id: "agent-parity",
      name: "Parity agent",
      slug: "parity-agent",
      version: 7,
      config: {
        ...agentConfig("pydantic-ai-agent-py", "kimi/kimi-k3"),
        reasoningEffort: "max",
      },
      projectId: "project-1",
      runtime: "pydantic-ai-agent-py",
      runtimeAppId: "agent-runtime-parity-agent",
      mlflowModelVersion: "model-7",
      mlflowModelName: "parity-agent",
      mlflowUri: "models:/parity-agent/7",
    };
    mocks.workflowData.getWorkflowEnsureSession
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "sess-codex-cli",
        agentId: "agent-parity",
        agentVersion: 7,
        userId: "user-1",
        projectId: "project-1",
        workflowExecutionId: null,
        parentExecutionId: null,
        vaultIds: [],
        sandboxName: "pydantic-ai-agent-py",
        runtimeAppId: null,
        runtimeSandboxName: null,
      });
    mocks.workflowData.resolveSessionAgentByRef
      .mockResolvedValueOnce(savedAgent)
      .mockResolvedValueOnce(savedAgent);
    mocks.workflowData.resolvePublishedWorkflowAgentForEnsure.mockResolvedValueOnce(
      {
        ok: true,
        agent: {
          agentId: "agent-parity",
          agentVersion: 7,
          agentSlug: "parity-agent",
          agentAppId: "agent-runtime-parity-agent",
          mlflowUri: "models:/parity-agent/7",
          mlflowModelName: "parity-agent",
          mlflowModelVersion: "model-7",
        },
      },
    );
    const responseSchema = {
      type: "object",
      properties: { result: { type: "string" } },
    };
    const body = {
      agentId: "agent-parity",
      agentVersion: 7,
      agentSlug: "parity-agent",
      agentConfig: {
        ...agentConfig("codex-cli", "openai/gpt-5.5"),
        reasoningEffort: "high",
        structuredOutputMode: "tool",
        responseJsonSchema: responseSchema,
      },
    };

    const initial = await callEnsureForWorkflow({
      runtime: "codex-cli",
      modelSpec: "openai/gpt-5.5",
      provider: "openai",
      token: '{"tokens":{"refresh_token":"codex"}}',
      body,
    });
    const replay = await callEnsureForWorkflow({
      runtime: "codex-cli",
      modelSpec: "openai/gpt-5.5",
      provider: "openai",
      token: '{"tokens":{"refresh_token":"codex"}}',
      body,
    });

    const initialConfig = (initial.childInput as Record<string, unknown>)
      .agentConfig as Record<string, unknown>;
    const replayConfig = (replay.childInput as Record<string, unknown>)
      .agentConfig as Record<string, unknown>;
    for (const key of [
      "runtime",
      "agentAppId",
      "modelSpec",
      "reasoningEffort",
      "structuredOutputMode",
      "responseJsonSchema",
    ]) {
      expect(replayConfig[key]).toEqual(initialConfig[key]);
    }
    expect(initialConfig).toMatchObject({
      runtime: "pydantic-ai-agent-py",
      agentAppId: "agent-runtime-parity-agent",
      modelSpec: "openai/gpt-5.5",
      reasoningEffort: "high",
      structuredOutputMode: "tool",
    });
    expect(initial.reused).toBe(false);
    expect(replay.reused).toBe(true);
  });

  it.each([
    ["agent id", { agentId: "agent-other" }],
    ["agent slug", { agentSlug: "other-agent" }],
    ["agent version", { agentVersion: 8 }],
    ["resolved agent ref", { resolveAgentSlug: "other-agent" }],
    ["resolved agent version", { resolveAgentVersion: 8 }],
  ])("rejects a replay with mismatched %s", async (_label, mismatch) => {
    mocks.workflowData.getWorkflowEnsureSession.mockResolvedValueOnce({
      id: "sess-codex-cli",
      agentId: "agent-pinned",
      agentVersion: 7,
      userId: "user-1",
      projectId: "project-1",
      workflowExecutionId: null,
      parentExecutionId: null,
      vaultIds: [],
      sandboxName: "pydantic-ai-agent-py",
      runtimeAppId: null,
      runtimeSandboxName: null,
    });
    mocks.workflowData.resolveSessionAgentByRef.mockResolvedValueOnce({
      id: "agent-pinned",
      name: "Pinned agent",
      slug: "pinned-agent",
      version: 7,
      config: agentConfig("pydantic-ai-agent-py", "kimi/kimi-k3"),
      projectId: "project-1",
      runtime: "pydantic-ai-agent-py",
      runtimeAppId: null,
      mlflowModelVersion: "model-7",
      mlflowModelName: "pinned-agent",
      mlflowUri: "models:/pinned-agent/7",
    });

    await expect(
      callEnsureForWorkflow({
        runtime: "pydantic-ai-agent-py",
        modelSpec: "kimi/kimi-k3",
        provider: "kimi",
        token: "kimi-test-token",
        body: {
          agentId: "agent-pinned",
          agentVersion: 7,
          agentSlug: "pinned-agent",
          ...mismatch,
        },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(mocks.workflowMcpSessionTokenSigner.sign).not.toHaveBeenCalled();
    expect(mocks.cliCredentials.getUserCredential).not.toHaveBeenCalled();
    expect(mocks.maybeProvisionAgentWorkflowHost).not.toHaveBeenCalled();
  });

  it.each([
    ["owner", { userId: "user-other" }],
    ["project", { projectId: "project-other" }],
    ["workflow execution", { workflowExecutionId: "execution-other" }],
    ["parent execution", { parentExecutionId: "parent-other" }],
  ])("rejects mismatched persisted %s lineage before effects", async (_label, mismatch) => {
    mocks.workflowData.getWorkflowEnsureSession.mockResolvedValueOnce({
      id: "sess-codex-cli",
      agentId: "agent-pinned",
      agentVersion: 7,
      userId: "user-1",
      projectId: "project-1",
      workflowExecutionId: "execution-1",
      parentExecutionId: "parent-1",
      vaultIds: [],
      sandboxName: "pydantic-ai-agent-py",
      runtimeAppId: null,
      runtimeSandboxName: null,
    });

    await expect(
      callEnsureForWorkflow({
        runtime: "pydantic-ai-agent-py",
        modelSpec: "kimi/kimi-k3",
        provider: "kimi",
        token: "kimi-test-token",
        body: {
          workflowExecutionId: "execution-1",
          parentExecutionId: "parent-1",
          ...mismatch,
        },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(mocks.workflowData.resolveSessionAgentByRef).not.toHaveBeenCalled();
    expect(mocks.workflowMcpSessionTokenSigner.sign).not.toHaveBeenCalled();
    expect(mocks.cliCredentials.getUserCredential).not.toHaveBeenCalled();
    expect(mocks.maybeProvisionAgentWorkflowHost).not.toHaveBeenCalled();
  });

  it("rejects an explicit body owner that conflicts with execution authority", async () => {
    mocks.workflowData.getWorkflowExecutionSessionOwnerContext.mockResolvedValueOnce({
      userId: "user-authoritative",
      workflowId: "wf-1",
      projectId: "project-1",
      status: "running",
      stopRequestedAt: null,
    });

    await expect(
      callEnsureForWorkflow({
        runtime: "pydantic-ai-agent-py",
        modelSpec: "kimi/kimi-k3",
        provider: "kimi",
        token: "kimi-test-token",
        body: {
          workflowExecutionId: "execution-1",
          userId: "user-other",
        },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(mocks.workflowData.resolveSessionAgentByRef).not.toHaveBeenCalled();
    expect(mocks.promptStackCompiler.compilePromptStack).not.toHaveBeenCalled();
    expect(mocks.workflowMcpSessionTokenSigner.sign).not.toHaveBeenCalled();
    expect(mocks.cliCredentials.getUserCredential).not.toHaveBeenCalled();
    expect(mocks.maybeProvisionAgentWorkflowHost).not.toHaveBeenCalled();
  });

	it("delegates evaluator goal persistence to the session goal service", async () => {
		const payload = await callEnsureForWorkflow({
			runtime: "agy-cli",
			modelSpec: "gemini/gemini-2.5-pro",
			provider: "google",
			token: "agy-bundle",
			body: {
				workflowExecutionId: "execution-1",
				goal: {
					objective: "finish the task",
					tokenBudget: 1234,
					maxIterations: 6,
					acceptanceCriteria: ["done"],
					evidence: { commands: ["pnpm check"] },
				},
			},
		});

		expect(mocks.sessionGoals.ensureWorkflowEvaluatorGoal).toHaveBeenCalledWith(
			{
				sessionId: "sess-agy-cli",
				objective: "finish the task",
				tokenBudget: 1234,
				maxIterations: 6,
				workflowExecutionId: "execution-1",
				acceptanceCriteria: ["done"],
				evidencePlan: { commands: ["pnpm check"] },
			},
		);
		expect(
			(payload.childInput as Record<string, unknown>).autoTerminateAfterEndTurn,
		).toBe(false);
		const childAgentConfig = (payload.childInput as Record<string, unknown>)
			.agentConfig as { mcpServers?: unknown[] };
		expect(childAgentConfig.mcpServers ?? []).toEqual([]);
	});

	it("delegates workflow repository materialization to the session command service", async () => {
		await callEnsureForWorkflow({
			runtime: "agy-cli",
			modelSpec: "gemini/gemini-2.5-pro",
			provider: "google",
			token: "agy-bundle",
			body: {
				workflowExecutionId: "execution-1",
				workspaceRef: "workspace/ws-ready",
				cwd: "/sandbox",
				agentConfig: {
					...agentConfig("agy-cli", "gemini/gemini-2.5-pro"),
					repositories: [
						{
							repoUrl: "https://github.com/PittampalliOrg/workflow-builder",
							checkoutRef: "main",
						},
					],
				},
			},
		});

		expect(
			mocks.sessionCommands.materializeWorkflowSessionRepositories,
		).toHaveBeenCalledWith({
			sessionId: "sess-agy-cli",
			repositories: [
				{
					repoUrl: "https://github.com/PittampalliOrg/workflow-builder",
					checkoutRef: "main",
				},
			],
			workflowExecutionId: "execution-1",
			workspaceRef: "workspace/ws-ready",
			cwd: "/sandbox",
		});
		expect(
			mocks.sessionCommands.reapTerminatedWorkflowSessionRuntimeHosts,
		).toHaveBeenCalledWith({
			workflowExecutionId: "execution-1",
			exceptSessionId: "sess-agy-cli",
		});
	});

	it("delegates workflow initial message persistence to the session command service", async () => {
		await callEnsureForWorkflow({
			runtime: "codex-cli",
			modelSpec: "openai/gpt-5.5",
			provider: "openai",
			token: '{"tokens":{"refresh_token":"codex"}}',
			body: {
				initialMessage: "hello",
			},
		});

		expect(
			mocks.sessionCommands.appendWorkflowSessionInitialMessage,
		).toHaveBeenCalledWith({
			sessionId: "sess-codex-cli",
			text: "hello",
		});
	});

	it.each([
		{
			runtime: "codex-cli" as const,
			modelSpec: "openai/gpt-5.5",
			provider: "openai",
			adapter: "codex",
			envVar: "CODEX_AUTH_JSON",
			token: '{"tokens":{"refresh_token":"codex"}}',
		},
		{
			runtime: "claude-code-cli" as const,
			modelSpec: "anthropic/claude-opus-4-8",
			provider: "anthropic",
			adapter: "claude-code",
			envVar: "CLAUDE_CODE_OAUTH_TOKEN",
			token: "claude-token",
		},
		{
			runtime: "agy-cli" as const,
			modelSpec: "gemini/gemini-2.5-pro",
			provider: "google",
			adapter: "antigravity",
			envVar: "AGY_AUTH_JSON",
			token: "agy-bundle",
		},
	])(
		"stamps $adapter and projects only $envVar for $runtime",
		async ({ runtime, modelSpec, provider, adapter, envVar, token }) => {
			const payload = await callEnsureForWorkflow({
				runtime,
				modelSpec,
				provider,
				token,
			});
			const childInput = payload.childInput as Record<string, unknown>;
			const childAgentConfig = childInput.agentConfig as Record<
				string,
				unknown
			>;
			expect(childAgentConfig.runtime).toBe(runtime);
			expect(childAgentConfig.cliAdapter).toBe(adapter);

			const hostCall = mocks.state.hostCalls[0] as {
				agentConfig: Record<string, unknown>;
				sessionSecretEnv: Record<string, string>;
			};
			expect(hostCall.agentConfig.cliAdapter).toBe(adapter);
			expect(Object.keys(hostCall.sessionSecretEnv)).toEqual([envVar]);
			expect(hostCall.sessionSecretEnv[envVar]).toBe(token);
		},
	);
});

describe("dynamic-script spawn MCP wiring", () => {
	beforeEach(() => {
		mocks.state.hostCalls.length = 0;
		mocks.workflowData.getWorkflowByRef.mockReset();
		mocks.workflowData.getWorkflowByRef.mockResolvedValue(null);
		mocks.workflowTargetAuth.mintAssertion.mockReset();
		mocks.workflowTargetAuth.mintAssertion.mockResolvedValue(
			"wfb_browser_auth_v1.signed.proof",
		);
	});

	it("adds signed session auth only to the explicit Workflow MCP connection", async () => {
		mocks.workflowData.getWorkflowByRef.mockResolvedValueOnce({
			engineType: "dynamic-script",
		});
		const payload = await callEnsureForWorkflow({
			runtime: "dapr-agent-py",
			modelSpec: "kimi/kimi-k3",
			provider: "openai",
			token: "unused",
			body: {
				workflowExecutionId: "execution-1",
				agentConfig: {
					...agentConfig("dapr-agent-py", "kimi/kimi-k3"),
					mcpServers: [
						{
							name: "trace",
							url: "http://workflow-mcp-server.workflow-builder.svc.cluster.local:3200/mcp",
							headers: {
									"x-wfb-session-id": "caller-session",
									"x-wfb-session-token": "caller-token",
							},
						},
						{
							name: "lookalike",
							url: "https://workflow-mcp-server.example.test/mcp",
						},
					],
				},
			},
		});

		const persistedCall = mocks.sessionCommands.resolveWorkflowSessionAgent.mock.calls.at(
			-1,
		)?.[0] as unknown as {
				agentConfig: { mcpServers: Array<Record<string, unknown>> };
			};
		expect(JSON.stringify(persistedCall.agentConfig)).not.toContain(
			"signed-workflow-mcp-session",
		);

		const childConfig = (payload.childInput as Record<string, unknown>)
			.agentConfig as { mcpServers: Array<Record<string, unknown>> };
		expect(childConfig.mcpServers[0]).toMatchObject({
			headers: {
				"X-Wfb-Session-Id": "sess-dapr-agent-py",
				"X-Wfb-Session-Token": "signed-workflow-mcp-session",
				"X-Wfb-Script-Depth": "1",
			},
		});
		expect(JSON.stringify(childConfig.mcpServers[1])).not.toContain(
			"signed-workflow-mcp-session",
		);
	});

	it("replaces persisted browser credentials and hosts with an execution assertion", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const payload = await callEnsureForWorkflow({
			runtime: "dapr-agent-py",
			modelSpec: "kimi/kimi-k3",
			provider: "openai",
			token: "unused",
			body: {
				workflowExecutionId: "execution-1",
				agentConfig: {
					...agentConfig("dapr-agent-py", "kimi/kimi-k3"),
					mcpServers: [
						{
							name: "browser",
							url: "http://agent-browser-mcp.workflow-builder.svc.cluster.local:8000/mcp",
								headers: {
									"X-Wfb-Target-Auth": "Bearer eyJ.user.signature",
									"X-Wfb-Target-Auth-Host": "attacker.example:443",
									"X-Wfb-Browser-Target-Assertion": "stale-assertion",
									"X-Wfb-Execution-Id": "caller-execution",
									"X-Wfb-Workflow-Id": "caller-workflow",
									"X-Wfb-Node-Id": "caller-node",
									"X-Wfb-Browser-Lane": "per-node",
							},
						},
						{
							name: "other",
							url: "http://other-mcp:8000/mcp",
							headers: { "X-Wfb-Target-Auth": "must-also-be-stripped" },
						},
					],
				},
			},
		});

		expect(mocks.workflowTargetAuth.mintAssertion).toHaveBeenCalledWith({
			executionId: "execution-1",
			expectedUserId: "user-1",
			expectedProjectId: "project-1",
		});
    const persistedCall =
      mocks.sessionCommands.resolveWorkflowSessionAgent.mock.calls.at(
        -1,
      )?.[0] as unknown as {
			agentConfig: { mcpServers: Array<Record<string, unknown>> };
		};
		const persisted = persistedCall.agentConfig;
    const persistedBrowserHeaders = persisted.mcpServers[0].headers as Record<
      string,
      string
    >;
		expect(persistedBrowserHeaders["X-Wfb-Target-Auth"]).toBeUndefined();
		expect(persistedBrowserHeaders["X-Wfb-Target-Auth-Host"]).toBeUndefined();
		expect(
			persistedBrowserHeaders["X-Wfb-Browser-Target-Assertion"],
		).toBeUndefined();
		expect(persistedBrowserHeaders["X-Wfb-Execution-Id"]).toBe("execution-1");
		expect(persistedBrowserHeaders["X-Wfb-Workflow-Id"]).toBe("wf-1");
		expect(persistedBrowserHeaders["X-Wfb-Node-Id"]).toBe("run-agent");

		const childInput = payload.childInput as Record<string, unknown>;
		const childConfig = childInput.agentConfig as {
			mcpServers: Array<Record<string, unknown>>;
		};
    const browserHeaders = childConfig.mcpServers[0].headers as Record<
      string,
      string
    >;
		expect(browserHeaders["X-Wfb-Browser-Target-Assertion"]).toBe(
			"wfb_browser_auth_v1.signed.proof",
		);
		expect(browserHeaders["X-Wfb-Target-Auth"]).toBeUndefined();
		expect(browserHeaders["X-Wfb-Target-Auth-Host"]).toBeUndefined();
		expect(browserHeaders["X-Wfb-Browser-Lane"]).toBe("per-node");
		expect(childConfig.mcpServers[1]).toEqual({
			name: "other",
			url: "http://other-mcp:8000/mcp",
			headers: {},
		});
    const hostConfig = (
      mocks.state.hostCalls.at(-1) as {
			agentConfig: { mcpServers: Array<Record<string, unknown>> };
      }
    ).agentConfig;
		expect(
			(hostConfig.mcpServers[0].headers as Record<string, string>)[
				"X-Wfb-Browser-Target-Assertion"
			],
		).toBe("wfb_browser_auth_v1.signed.proof");

		const { childInput: _childInput, ...topLevel } = payload;
		expect(JSON.stringify(persisted)).not.toContain("eyJ.user.signature");
		expect(JSON.stringify(payload)).not.toContain("eyJ.user.signature");
		expect(JSON.stringify(payload)).not.toContain("Bearer");
		expect(JSON.stringify(payload)).not.toContain("attacker.example");
		expect(JSON.stringify(payload)).not.toContain("wb_access_token");
		expect(JSON.stringify(topLevel)).not.toContain("signed.proof");
		expect(JSON.stringify(log.mock.calls)).not.toContain("signed.proof");
		expect(JSON.stringify(info.mock.calls)).not.toContain("signed.proof");
		expect(JSON.stringify(warn.mock.calls)).not.toContain("signed.proof");
		log.mockRestore();
		info.mockRestore();
		warn.mockRestore();
	});

	it("does not send assertions or run identity to a non-FQDN browser endpoint", async () => {
		const payload = await callEnsureForWorkflow({
			runtime: "dapr-agent-py",
			modelSpec: "kimi/kimi-k3",
			provider: "openai",
			token: "unused",
			body: {
				workflowExecutionId: "execution-1",
				agentConfig: {
					...agentConfig("dapr-agent-py", "kimi/kimi-k3"),
					mcpServers: [
						{
							url: "http://agent-browser-mcp:8000/mcp",
							headers: {
								"X-Wfb-Target-Auth": "Bearer stale-token",
							},
						},
					],
				},
			},
		});

		expect(mocks.workflowTargetAuth.mintAssertion).not.toHaveBeenCalled();
		const config = (payload.childInput as Record<string, unknown>)
			.agentConfig as { mcpServers: Array<Record<string, unknown>> };
		expect(config.mcpServers[0].headers).toEqual({});
		expect(JSON.stringify(config)).not.toContain("X-Wfb-Execution-Id");
		expect(JSON.stringify(config)).not.toContain("stale-token");
	});

	it("strips stale auth and omits an assertion when execution ownership is absent", async () => {
		const payload = await callEnsureForWorkflow({
			runtime: "dapr-agent-py",
			modelSpec: "kimi/kimi-k3",
			provider: "openai",
			token: "unused",
			body: {
				agentConfig: {
					...agentConfig("dapr-agent-py", "kimi/kimi-k3"),
					mcpServers: [
						{
							url: "http://agent-browser-mcp.workflow-builder.svc.cluster.local:8000/mcp",
							headers: {
								"X-Wfb-Target-Auth": "Bearer stale-persisted-token",
								"X-Wfb-Target-Auth-Host": "attacker.example",
								"X-Wfb-Browser-Target-Assertion": "stale-assertion",
							},
						},
					],
				},
			},
		});

		expect(mocks.workflowTargetAuth.mintAssertion).not.toHaveBeenCalled();
		const config = (payload.childInput as Record<string, unknown>)
			.agentConfig as { mcpServers: Array<Record<string, unknown>> };
		expect(config.mcpServers[0].headers).not.toHaveProperty(
			"X-Wfb-Target-Auth",
		);
		expect(config.mcpServers[0].headers).not.toHaveProperty(
			"X-Wfb-Target-Auth-Host",
		);
		expect(config.mcpServers[0].headers).not.toHaveProperty(
			"X-Wfb-Browser-Target-Assertion",
		);
	});

	it("leaves CLI dynamic-script spawns without default goal MCP wiring", async () => {
		mocks.workflowData.getWorkflowByRef.mockResolvedValue({
			engineType: "dynamic-script",
		} as never);
		const payload = await callEnsureForWorkflow({
			runtime: "claude-code-cli",
			modelSpec: "anthropic/claude-opus-4-8",
			provider: "anthropic",
			token: "claude-token",
		});
		const childInput = payload.childInput as Record<string, unknown>;
    const config = childInput.agentConfig as {
      mcpServers?: Array<Record<string, unknown>>;
    };
		const servers = config.mcpServers ?? [];
		expect(servers).toEqual([]);
	});

	it("does not auto-wire any goal MCP server for non-CLI dynamic-script spawns", async () => {
		// The goal MCP server (create/update/get_goal) is no longer injected —
		// goals are authored in code and completed by the BFF evidence backstop.
		mocks.workflowData.getWorkflowByRef.mockResolvedValue({
			engineType: "dynamic-script",
		} as never);
		const payload = await callEnsureForWorkflow({
			runtime: "dapr-agent-py",
			modelSpec: "openai/gpt-5.5",
			provider: "openai",
			token: "unused",
		});
		const childInput = payload.childInput as Record<string, unknown>;
		const config = childInput.agentConfig as {
			mcpServers?: Array<Record<string, unknown>>;
		};
		const servers = config.mcpServers ?? [];
		expect(servers).toEqual([]);
	});

	it("loads the resolved DB agent's full config (mcpServers/systemPrompt/builtinTools) for dynamic-script agent({agent})", async () => {
		mocks.workflowData.getWorkflowByRef.mockResolvedValue({
			engineType: "dynamic-script",
		} as never);
		// The script names a registered agent by slug; the orchestrator only sends
		// a minimal per-call config (no mcpServers/systemPrompt/builtinTools).
		mocks.teamStore.resolveAgentIdBySlug.mockResolvedValue({
			id: "kimi-k3-browser-agent-id",
		});
		mocks.workflowData.resolveSessionAgentByRef.mockResolvedValue({
      id: "kimi-k3-browser-agent-id",
      name: "Kimi browser agent",
      slug: "kimi-k3-browser-agent",
      version: 3,
			config: {
				runtime: "dapr-agent-py",
				modelSpec: "kimi/kimi-k3",
				reasoningEffort: "max",
				contextWindowTokens: 1_048_576,
				systemPrompt: "You are a browser automation agent.",
				builtinTools: ["execute_command", "read_file"],
				skills: [],
				mcpConnectionMode: "auto",
				mcpServers: [
					{
						name: "agent-browser",
						transport: "streamable_http",
						url: "http://agent-browser-mcp.workflow-builder.svc.cluster.local:8000/mcp",
					},
				],
				runtimeOverridePolicy: RUNTIME_POLICY,
			},
			projectId: "project-1",
      runtime: "dapr-agent-py",
      runtimeAppId: null,
		});
		const payload = await callEnsureForWorkflow({
			runtime: "dapr-agent-py",
			modelSpec: "kimi/kimi-k3",
			provider: "openai",
			token: "unused",
      body: {
        resolveAgentSlug: "kimi-k3-browser-agent",
        agentSlug: "kimi-k3-browser-agent",
      },
		});
		const childInput = payload.childInput as Record<string, unknown>;
		const config = childInput.agentConfig as {
			mcpServers?: Array<Record<string, unknown>>;
			systemPrompt?: string;
			builtinTools?: string[];
			modelSpec?: string;
			reasoningEffort?: string;
			contextWindowTokens?: number;
		};
		// The DB agent's own systemPrompt + builtinTools survive (were dropped before).
		expect(config.systemPrompt).toBe("You are a browser automation agent.");
		expect(config.builtinTools).toEqual(["execute_command", "read_file"]);
		expect(config.modelSpec).toBe("kimi/kimi-k3");
		expect(config.reasoningEffort).toBe("max");
		expect(config.contextWindowTokens).toBe(1_048_576);
		// The DB agent's agent-browser MCP server survives; no goal MCP server
		// is auto-wired anymore.
		const servers = config.mcpServers ?? [];
		const urls = servers.map((s) => String(s.url));
		expect(urls.some((u) => u.includes("agent-browser-mcp"))).toBe(true);
		expect(urls.some((u) => u.includes("workflow-mcp-server"))).toBe(false);
		// The resolved agent id flows to the child session.
		expect(childInput.resolvedAgentSlug ?? payload.resolvedAgentSlug).toBe(
			"kimi-k3-browser-agent",
		);
	});

	it("uses the resolved named agent runtime instead of the generic dynamic-script runtime", async () => {
		mocks.workflowData.getWorkflowByRef.mockResolvedValue({
			engineType: "dynamic-script",
		} as never);
		mocks.teamStore.resolveAgentIdBySlug.mockResolvedValue({
			id: "glm-juicefs-agent-id",
		});
		mocks.workflowData.resolveSessionAgentByRef.mockResolvedValue({
      id: "glm-juicefs-agent-id",
      name: "Kimi JuiceFS agent",
      slug: "kimi-k3-juicefs-builder-agent",
      version: 3,
			config: {
				runtime: "dapr-agent-py-juicefs",
				modelSpec: "kimi/kimi-k3",
				reasoningEffort: "max",
				contextWindowTokens: 1_048_576,
				runtimeIsolation: "dedicated",
				skills: [],
				mcpServers: [],
				runtimeOverridePolicy: RUNTIME_POLICY,
			},
			projectId: "project-1",
			runtime: "dapr-agent-py-juicefs",
			runtimeAppId: "agent-runtime-kimi-k3-juicefs-builder-agent",
		} as never);
		const payload = await callEnsureForWorkflow({
			runtime: "dapr-agent-py",
			modelSpec: "kimi/kimi-k3",
			provider: "openai",
			token: "unused",
      body: {
        resolveAgentSlug: "kimi-k3-juicefs-builder-agent",
        agentSlug: "kimi-k3-juicefs-builder-agent",
      },
		});

		expect(payload.agentAppId).toBe("agent-session-test");
		const hostCall = mocks.state.hostCalls.at(-1) as {
			agentConfig?: Record<string, unknown>;
		};
		expect(hostCall.agentConfig?.runtime).toBe("dapr-agent-py-juicefs");
		expect(hostCall.agentConfig?.agentAppId).toBe(
			"agent-runtime-kimi-k3-juicefs-builder-agent",
		);
		const childInput = payload.childInput as Record<string, unknown>;
		const config = childInput.agentConfig as Record<string, unknown>;
		expect(config.runtime).toBe("dapr-agent-py-juicefs");
		expect(config.modelSpec).toBe("kimi/kimi-k3");
		expect(config.reasoningEffort).toBe("max");
		expect(config.contextWindowTokens).toBe(1_048_576);
		expect(config.runtimeIsolation).toBe("dedicated");
    expect(config.agentAppId).toBe(
      "agent-runtime-kimi-k3-juicefs-builder-agent",
    );
		expect(childInput.sandboxName).toBe("dapr-agent-py-juicefs");
	});

	it("refuses StructuredOutput when the saved agent resolves to an unsupported runtime", async () => {
		mocks.teamStore.resolveAgentIdBySlug.mockResolvedValue({
			id: "unsupported-agent-id",
		});
		mocks.workflowData.resolveSessionAgentByRef.mockResolvedValue({
      id: "unsupported-agent-id",
      name: "Unsupported agent",
      slug: "unsupported-agent",
      version: 3,
			config: {
				runtime: "claude-code-cli",
				modelSpec: "anthropic/claude-opus-4-8",
				mcpServers: [],
				skills: [],
				runtimeOverridePolicy: RUNTIME_POLICY,
			},
			projectId: "project-1",
			runtime: "claude-code-cli",
			runtimeAppId: null,
		} as never);

		const payload = await callEnsureForWorkflow({
			runtime: "dapr-agent-py",
			modelSpec: "kimi/kimi-k3",
			provider: "openai",
			token: "unused",
			body: {
				resolveAgentSlug: "unsupported-agent",
        agentSlug: "unsupported-agent",
				agentConfig: {
					...agentConfig("dapr-agent-py", "kimi/kimi-k3"),
					structuredOutputMode: "tool",
					responseJsonSchema: {
						type: "object",
						properties: { summary: { type: "string" } },
					},
				},
			},
		});

		expect(payload).toMatchObject({ code: "agent_ref_unresolved" });
		expect(String(payload.error)).toContain("runtime 'claude-code-cli'");
		expect(mocks.state.hostCalls).toHaveLength(0);
	});

	it("leaves single-shot SW-1.0 spawns without MCP wiring", async () => {
		const payload = await callEnsureForWorkflow({
			runtime: "claude-code-cli",
			modelSpec: "anthropic/claude-opus-4-8",
			provider: "anthropic",
			token: "claude-token",
		});
		const childInput = payload.childInput as Record<string, unknown>;
		const config = childInput.agentConfig as { mcpServers?: unknown[] };
		expect(config.mcpServers ?? []).toEqual([]);
	});
});

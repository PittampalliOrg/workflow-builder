import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "$lib/types/agents";

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

	return {
		state,
		validateInternalToken: vi.fn(() => true),
		maybeProvisionAgentWorkflowHost: vi.fn(async (params: unknown) => {
			state.hostCalls.push(params);
			return {
				agentAppId: "agent-session-test",
				sandboxName: "sandbox-test",
				status: "ready",
			};
		}),
		workflowData: {
			getWorkflowByRef: vi.fn(async () => null),
			getWorkflowExecutionSessionOwnerContext: vi.fn(async () => null),
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
					workflowExecutionId: string | null;
					vaultIds: unknown[];
					sandboxName: string | null;
					runtimeSandboxName: string | null;
				} | null> => null,
			),
			createWorkflowEnsureSession: vi.fn(async (input: unknown) => {
				state.inserted.push(input);
			}),
			updateWorkflowEnsureSessionRuntime: vi.fn(async (input: unknown) => {
				state.updates.push(input);
			}),
			resolveSessionAgentByRef: vi.fn(
				async (): Promise<{
					config: Record<string, unknown>;
					projectId: string | null;
				} | null> => null,
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
			materializeWorkflowSessionRepositories: vi.fn(async () => undefined),
			reapTerminatedWorkflowSessionRuntimeHosts: vi.fn(async () => undefined),
			appendWorkflowSessionSwapDegradedEvent: vi.fn(async () => undefined),
			appendWorkflowSessionInitialMessage: vi.fn(async () => undefined),
			resolveWorkflowSessionAgent: vi.fn(
				async (input: {
					publishedAgent: { agentId: string; agentVersion: number } | null;
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
			mintAccessToken: vi.fn(async () => "fresh-target-access-token"),
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
		promptStackCompiler: mocks.promptStackCompiler,
		workflowTargetAuth: mocks.workflowTargetAuth,
    workflowMcpSessionTokenSigner: mocks.workflowMcpSessionTokenSigner,
		teamStore: mocks.teamStore,
		capabilityBundles: mocks.capabilityBundles,
	}),
}));

vi.mock("$lib/server/sessions/agent-workflow-host", () => ({
	extractTraceContext: () => ({
		traceparent: null,
		tracestate: null,
		baggage: null,
	}),
	maybeProvisionAgentWorkflowHost: mocks.maybeProvisionAgentWorkflowHost,
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
		expect(source).not.toContain("registerAgentVersionInMlflow");
		expect(source).not.toContain("benchmarkRuns");
		expect(source).not.toContain("benchmarkRunInstances");
		expect(source).not.toContain("select({ slug: agents.slug");
		expect(source).not.toContain("db.insert(sessions)");
		expect(source).not.toContain("db.update(sessions)");
		expect(source).not.toContain("from(sessions)");
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
		expect(childInput.agentId).toBe("agent-published");
		expect(childInput.agentVersion).toBe(9);
		expect(childInput.agentSlug).toBe("published-agent");
		expect(childInput.activeModelId).toBe("model-3");
		expect(childInput.activeModelName).toBe("published-agent");
		expect(childInput.activeModelUri).toBe("models:/published-agent/3");
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
			workflowExecutionId: "execution-1",
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
		mocks.workflowTargetAuth.mintAccessToken.mockReset();
		mocks.workflowTargetAuth.mintAccessToken.mockResolvedValue(
			"fresh-target-access-token",
		);
	});

	it("replaces stale browser target auth only in execution-scoped config", async () => {
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
							url: "http://agent-browser-mcp:8000/mcp",
							headers: {
								"X-Wfb-Target-Auth": "Bearer stale-persisted-token",
								"X-Wfb-Target-Auth-Host": "workflow-builder:3000",
								"X-Wfb-Browser-Lane": "per-node",
							},
						},
						{
							name: "other",
							url: "http://other-mcp:8000/mcp",
							headers: { "X-Wfb-Target-Auth": "non-browser-untouched" },
						},
					],
				},
			},
		});

		expect(mocks.workflowTargetAuth.mintAccessToken).toHaveBeenCalledWith({
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
		expect(persistedBrowserHeaders["X-Wfb-Target-Auth-Host"]).toBe(
			"workflow-builder:3000",
		);

		const childInput = payload.childInput as Record<string, unknown>;
		const childConfig = childInput.agentConfig as {
			mcpServers: Array<Record<string, unknown>>;
		};
    const browserHeaders = childConfig.mcpServers[0].headers as Record<
      string,
      string
    >;
		expect(browserHeaders["X-Wfb-Target-Auth"]).toBe(
			"Bearer fresh-target-access-token",
		);
		expect(browserHeaders["X-Wfb-Browser-Lane"]).toBe("per-node");
		expect(childConfig.mcpServers[1]).toEqual({
			name: "other",
			url: "http://other-mcp:8000/mcp",
			headers: { "X-Wfb-Target-Auth": "non-browser-untouched" },
		});
    const hostConfig = (
      mocks.state.hostCalls.at(-1) as {
			agentConfig: { mcpServers: Array<Record<string, unknown>> };
      }
    ).agentConfig;
		expect(
			(hostConfig.mcpServers[0].headers as Record<string, string>)[
				"X-Wfb-Target-Auth"
			],
		).toBe("Bearer fresh-target-access-token");

		const { childInput: _childInput, ...topLevel } = payload;
		expect(JSON.stringify(topLevel)).not.toContain("fresh-target-access-token");
		expect(JSON.stringify(log.mock.calls)).not.toContain(
			"fresh-target-access-token",
		);
		expect(JSON.stringify(info.mock.calls)).not.toContain(
			"fresh-target-access-token",
		);
		expect(JSON.stringify(warn.mock.calls)).not.toContain(
			"fresh-target-access-token",
		);
		log.mockRestore();
		info.mockRestore();
		warn.mockRestore();
	});

	it("strips stale auth without minting when the browser target host is absent", async () => {
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
								"X-Wfb-Target-Auth": "Bearer stale-persisted-token",
							},
						},
					],
				},
			},
		});

		expect(mocks.workflowTargetAuth.mintAccessToken).not.toHaveBeenCalled();
		const config = (payload.childInput as Record<string, unknown>)
			.agentConfig as { mcpServers: Array<Record<string, unknown>> };
		expect(config.mcpServers[0].headers).not.toHaveProperty(
			"X-Wfb-Target-Auth",
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
		});
		const payload = await callEnsureForWorkflow({
			runtime: "dapr-agent-py",
			modelSpec: "kimi/kimi-k3",
			provider: "openai",
			token: "unused",
			body: { resolveAgentSlug: "kimi-k3-browser-agent" },
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
			body: { resolveAgentSlug: "kimi-k3-juicefs-builder-agent" },
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
		expect(config.agentAppId).toBe("agent-runtime-kimi-k3-juicefs-builder-agent");
		expect(childInput.sandboxName).toBe("dapr-agent-py-juicefs");
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

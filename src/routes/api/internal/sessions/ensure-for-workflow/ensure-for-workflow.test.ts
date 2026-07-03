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
		credentials: {} as Record<string, { token: string; expiresAt: Date | null }>,
	};

	return {
		state,
		validateInternalToken: vi.fn(() => true),
		findOrCreateEphemeralAgent: vi.fn(async () => ({
			agentId: "agent-test",
			agentVersion: 4,
		})),
		syncAgentRuntimeCR: vi.fn(async () => undefined),
		compilePromptStack: vi.fn(async () => ({
			static: [],
			dynamic: [],
			staticManifest: [],
			dynamicManifest: [],
		})),
		getUserCliCredential: vi.fn(async (_userId: string, provider: string) => {
			return state.credentials[provider] ?? null;
		}),
		maybeProvisionAgentWorkflowHost: vi.fn(async (params: unknown) => {
			state.hostCalls.push(params);
			return {
				agentAppId: "agent-session-test",
				sandboxName: "sandbox-test",
				status: "ready",
			};
		}),
		workflowData: {
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
			resolvePublishedWorkflowAgentForEnsure: vi.fn(async (input: {
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
			}),
			getWorkflowEnsureSession: vi.fn(async () => null),
			createWorkflowEnsureSession: vi.fn(async (input: unknown) => {
				state.inserted.push(input);
			}),
			updateWorkflowEnsureSessionRuntime: vi.fn(async (input: unknown) => {
				state.updates.push(input);
			}),
			listTerminalWorkflowSessionRuntimeHosts: vi.fn(async () => []),
		},
		sessionGoals: {
			ensureWorkflowEvaluatorGoal: vi.fn(async () => ({ status: "created" })),
		},
		sessionCommands: {
			materializeWorkflowSessionRepositories: vi.fn(async () => undefined),
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
		sessionCommands: mocks.sessionCommands,
	}),
}));

vi.mock("$lib/server/agents/ephemeral", () => ({
	findOrCreateEphemeralAgent: mocks.findOrCreateEphemeralAgent,
}));

vi.mock("$lib/server/agents/registry-sync", () => ({
	syncAgentRuntimeCR: mocks.syncAgentRuntimeCR,
}));

vi.mock("$lib/server/prompt-presets", () => ({
	compilePromptStack: mocks.compilePromptStack,
}));

vi.mock("$lib/server/users/cli-credentials", () => ({
	getUserCliCredential: mocks.getUserCliCredential,
	cliCredentialNeedsBootLease: vi.fn(() => false),
}));

vi.mock("$lib/server/sessions/agent-workflow-host", () => ({
	extractTraceContext: () => ({
		traceparent: null,
		tracestate: null,
		baggage: null,
	}),
	maybeProvisionAgentWorkflowHost: mocks.maybeProvisionAgentWorkflowHost,
}));

vi.mock("$lib/server/sessions/events", () => ({
	appendEvent: vi.fn(async () => undefined),
	sendUserEvent: vi.fn(async () => undefined),
}));

vi.mock("$lib/server/observability/mlflow-lifecycle", () => ({
	registerAgentVersionInMlflow: vi.fn(async () => null),
	safeCreateWorkflowAgentMlflowRun: vi.fn(async () => null),
}));

import { POST } from "./+server";

const RUNTIME_POLICY = {
	allowToolNarrowing: true,
	allowServerAdditions: false,
	allowCredentialBinding: true,
	allowSkillAdditions: false,
	allowSkillNarrowing: true,
};

function agentConfig(runtime: AgentConfig["runtime"], modelSpec: string): AgentConfig {
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

		expect(source).toContain("workflowData.getWorkflowExecutionSessionOwnerContext");
		expect(source).toContain("workflowData.checkBenchmarkSessionProvisioningGate");
		expect(source).toContain("workflowData.getWorkflowAgentRuntimeIdentity");
		expect(source).toContain("workflowData.resolvePublishedWorkflowAgentForEnsure");
		expect(source).toContain("workflowData.getWorkflowEnsureSession");
		expect(source).toContain("workflowData.createWorkflowEnsureSession");
		expect(source).toContain("workflowData.updateWorkflowEnsureSessionRuntime");
		expect(source).toContain("sessionGoals.ensureWorkflowEvaluatorGoal");
		expect(source).toContain("sessionCommands.materializeWorkflowSessionRepositories");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/goals/repo");
		expect(source).not.toContain("$lib/server/sessions/registry");
		expect(source).not.toContain("$lib/server/sessions/repositories");
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

		expect(mocks.workflowData.resolvePublishedWorkflowAgentForEnsure).toHaveBeenCalledWith({
			agentId: "agent-published",
			agentVersion: 9,
			projectId: "project-1",
		});
		expect(mocks.findOrCreateEphemeralAgent).not.toHaveBeenCalled();
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

		expect(mocks.workflowData.resolvePublishedWorkflowAgentForEnsure).toHaveBeenCalledWith({
			agentId: null,
			agentVersion: null,
			projectId: "project-1",
		});
		expect(mocks.findOrCreateEphemeralAgent).toHaveBeenCalled();
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

		expect(mocks.sessionGoals.ensureWorkflowEvaluatorGoal).toHaveBeenCalledWith({
			sessionId: "sess-agy-cli",
			objective: "finish the task",
			tokenBudget: 1234,
			maxIterations: 6,
			workflowExecutionId: "execution-1",
			acceptanceCriteria: ["done"],
			evidencePlan: { commands: ["pnpm check"] },
		});
		expect((payload.childInput as Record<string, unknown>).autoTerminateAfterEndTurn).toBe(false);
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
			const childAgentConfig = childInput.agentConfig as Record<string, unknown>;
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

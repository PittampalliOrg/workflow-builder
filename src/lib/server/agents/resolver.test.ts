import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const resolveSessionAgentByRefMock = vi.fn();
const resolvePeerAgentDispatchContextMock = vi.fn();
const resolveRuntimeByRefMock = vi.fn();
const flattenBundlesMock = vi.fn(
	async (config: unknown, _projectId?: unknown) => config,
);
const agentSkillHydrationMock = {
	listAgentSkillHydrationEntries: vi.fn(async () => []),
};
vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowData: {
			resolveSessionAgentByRef: (...args: unknown[]) =>
				resolveSessionAgentByRefMock(...args),
			resolvePeerAgentDispatchContext: (...args: unknown[]) =>
				resolvePeerAgentDispatchContextMock(...args),
		},
		environments: {
			resolveRuntimeByRef: (...args: unknown[]) =>
				resolveRuntimeByRefMock(...args),
		},
		capabilityBundles: {
			flattenBundles: (config: unknown, projectId: unknown) =>
				flattenBundlesMock(config, projectId),
		},
		agentSkillHydration: agentSkillHydrationMock,
	}),
}));

import {
	AgentRefResolutionError,
	assertConsistentWorkspaceBackends,
	collectDurableRunTasks,
	resolveSpecAgentRefs,
	WorkspaceBackendMismatchError,
} from "./resolver";
import type { AgentConfig } from "$lib/types/agents";
import type { EnvironmentConfig } from "$lib/types/environments";

function minimalEnv(
	overrides: Partial<EnvironmentConfig> = {},
): EnvironmentConfig {
	return {
		sandboxTemplate: "dapr-agent",
		sandboxMode: "per-run",
		keepAfterRun: false,
		ttlSeconds: 7200,
		networking: { type: "unrestricted" },
		...overrides,
	};
}

function minimalConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		builtinTools: ["read_file"],
		mcpConnectionMode: "explicit",
		mcpServers: [],
		skills: [],
		runtime: "dapr-agent-py",
		runtimeOverridePolicy: {
			allowToolNarrowing: true,
			allowServerAdditions: false,
			allowCredentialBinding: true,
			allowSkillAdditions: false,
			allowSkillNarrowing: true,
		},
		...overrides,
	};
}

function specWithTasks(tasks: Record<string, unknown>[]): Record<string, unknown> {
	return { document: { do: tasks } };
}

describe("collectDurableRunTasks", () => {
	it("collects a flat list of durable/run tasks", () => {
		const spec = specWithTasks([
			{ First: { call: "durable/run", with: {} } },
			{ Second: { call: "system/http-request", with: {} } },
			{ Third: { call: "durable/run", with: {} } },
		]);
		const out = collectDurableRunTasks(spec);
		expect(out.map((t) => t.taskName)).toEqual(["First", "Third"]);
	});

	it("descends into nested do blocks", () => {
		const spec = specWithTasks([
			{
				Outer: {
					call: "composite",
					do: [{ Inner: { call: "durable/run", with: {} } }],
				},
			},
		]);
		const out = collectDurableRunTasks(spec);
		expect(out.map((t) => t.taskName)).toEqual(["Inner"]);
	});
});

function resolvedAgent(
	overrides: Partial<{
		id: string;
		slug: string;
		version: number;
		config: AgentConfig;
		environmentId: string | null;
		environmentVersion: number | null;
		defaultVaultIds: string[];
		runtimeAppId: string | null;
	}> = {},
) {
	return {
		id: "a1",
		slug: "code-agent",
		version: 1,
		config: minimalConfig(),
		environmentId: null,
		environmentVersion: null,
		defaultVaultIds: [],
		runtimeAppId: null,
		...overrides,
	};
}

describe("resolveSpecAgentRefs", () => {
	beforeEach(() => {
		resolveSessionAgentByRefMock.mockReset();
		resolvePeerAgentDispatchContextMock.mockReset();
		resolveRuntimeByRefMock.mockReset();
		flattenBundlesMock.mockClear();
		agentSkillHydrationMock.listAgentSkillHydrationEntries.mockClear();
		resolvePeerAgentDispatchContextMock.mockResolvedValue({
			agentConfig: minimalConfig(),
			environmentConfig: null,
			callableAgents: [],
			registryTeam: null,
		});
		delete process.env.AGENT_RUNTIME_SHARED_POOLS_ENABLED;
		delete process.env.AGENT_RUNTIME_POOL_APP_IDS_JSON;
	});

	it("inlines resolved agentConfig and strips agentRef", async () => {
		const config = minimalConfig({
			modelSpec: "anthropic/claude-opus-4-7",
			systemPrompt: "Sentinel system prompt",
		});
		resolveSessionAgentByRefMock.mockResolvedValueOnce(
			resolvedAgent({ version: 3, config }),
		);
		const spec = specWithTasks([
			{
				Run: {
					call: "durable/run",
					with: {
						body: {
							prompt: "hello",
							agentRef: { id: "a1" },
						},
					},
				},
			},
		]);

		const resolved = await resolveSpecAgentRefs(spec);
		const task = (resolved.document as Record<string, unknown>).do as Array<
			Record<string, unknown>
		>;
		const withBlock = (task[0].Run as Record<string, unknown>).with as Record<
			string,
			unknown
		>;
		const body = withBlock.body as Record<string, unknown>;
		expect(body.agentRef).toBeUndefined();
		expect(body.agentConfig).toEqual(config);
		expect((body.instructionBundle as Record<string, unknown>).instructionHash).toMatch(
			/^[a-f0-9]{64}$/,
		);
		expect(
			((body.instructionBundle as Record<string, unknown>).rendered as Record<
				string,
				unknown
			>).system,
		).toContain("Sentinel system prompt");
		expect(
			((body.instructionBundle as Record<string, unknown>).rendered as Record<
				string,
				unknown
			>).system,
		).toContain("You are dapr-agent-py");
		expect((body.instructionBundle as Record<string, unknown>).templateName).toBe(
			"workflow-builder canonical bundle",
		);
		expect(body.agentId).toBe("a1");
		expect(body.agentVersion).toBe(3);
		// Concurrency plan P3: dapr-agent-py carries registry hostMode
		// "shared-pool", so the resolver stamps the class pool app-id.
		expect(body.agentAppId).toBe("agent-runtime-pool-coding");
		expect(body.agentSlug).toBe("code-agent");
		expect(body.prompt).toBe("hello");
		expect(withBlock.agentRef).toBeUndefined();
		expect(withBlock.agentConfig).toEqual(config);
		expect(withBlock.instructionBundle).toEqual(body.instructionBundle);
		expect(withBlock.agentRuntime).toBe("dapr-agent-py");
		expect(withBlock.agentId).toBe("a1");
		expect(withBlock.agentVersion).toBe(3);
		expect(withBlock.agentAppId).toBe("agent-runtime-pool-coding");
		expect(withBlock.agentSlug).toBe("code-agent");
	});

	it("carries interactive-cli effort/options fields through to the dispatched agentConfig", async () => {
		// Load-bearing round-trip: the new AgentConfig fields (effort,
		// fallbackModelSpec, codexReasoningSummary, codexWebSearch) must survive the
		// BFF→sandbox path so `effort` actually reaches cli-agent-py. They ride the
		// SAME pass-through as `modelSpec`: the agent-row config flows through
		// flattenBundles → applyOverrides → stampCliAdapterForRuntime and is written
		// verbatim onto the durable/run node's `with.agentConfig` + `with.body.agentConfig`
		// (there is no zod schema / allowlist / field-pick on this path that would drop
		// unknown keys). This test fails loudly if someone later adds one.
		const config = minimalConfig({
			runtime: "claude-code-cli",
			modelSpec: "anthropic/claude-opus-4-8",
			effort: "ultracode",
			fallbackModelSpec: "anthropic/claude-sonnet-4-6",
			codexReasoningEffort: "xhigh",
			codexReasoningSummary: "detailed",
			codexWebSearch: true,
		});
		resolveSessionAgentByRefMock.mockResolvedValueOnce(
			resolvedAgent({ version: 2, slug: "ultra-agent", config }),
		);
		const spec = specWithTasks([
			{
				Run: {
					call: "durable/run",
					with: { body: { prompt: "hi", agentRef: { id: "a1" } } },
				},
			},
		]);

		const resolved = await resolveSpecAgentRefs(spec);
		const task = (resolved.document as Record<string, unknown>).do as Array<
			Record<string, unknown>
		>;
		const withBlock = (task[0].Run as Record<string, unknown>).with as Record<
			string,
			unknown
		>;
		for (const target of [
			withBlock.agentConfig,
			(withBlock.body as Record<string, unknown>).agentConfig,
		]) {
			const ac = target as Record<string, unknown>;
			expect(ac.modelSpec).toBe("anthropic/claude-opus-4-8");
			expect(ac.effort).toBe("ultracode");
			expect(ac.fallbackModelSpec).toBe("anthropic/claude-sonnet-4-6");
			expect(ac.codexReasoningEffort).toBe("xhigh");
			expect(ac.codexReasoningSummary).toBe("detailed");
			expect(ac.codexWebSearch).toBe(true);
		}
	});

	it("hydrates skill registry entries through the injected repository", async () => {
		const config = minimalConfig({
			skills: [
				{
					name: "spreadsheet-helper",
					registryId: "skill_1",
				},
			],
		});
		resolveSessionAgentByRefMock.mockResolvedValueOnce(resolvedAgent({ config }));
		const skillHydration = {
			listAgentSkillHydrationEntries: vi.fn(async () => [
				{
					id: "skill_1",
					prompt: "Use spreadsheet formulas carefully.",
					allowedTools: ["read_file", "write_file"],
					description: "Spreadsheet helper",
					whenToUse: "When editing spreadsheets",
					arguments: ["path"],
					argumentHint: "Workbook path",
					model: "openai/gpt-5.5",
					packageManifest: { files: [{ path: "SKILL.md" }] },
					skillName: "spreadsheet-helper",
					slug: "spreadsheet-helper",
					version: "2",
				},
			]),
		};
		const spec = specWithTasks([
			{
				Run: {
					call: "durable/run",
					with: {
						body: {
							prompt: "hello",
							agentRef: { id: "a1" },
						},
					},
				},
			},
		]);

		const resolved = await resolveSpecAgentRefs(spec, { skillHydration });
		const task = (resolved.document as Record<string, unknown>).do as Array<
			Record<string, unknown>
		>;
		const withBlock = (task[0].Run as Record<string, unknown>).with as Record<
			string,
			unknown
		>;
		const body = withBlock.body as Record<string, unknown>;
		const skill = ((body.agentConfig as AgentConfig).skills[0] ??
			{}) as Record<string, unknown>;

		expect(skillHydration.listAgentSkillHydrationEntries).toHaveBeenCalledWith([
			"skill_1",
		]);
		expect(skill.prompt).toBe("Use spreadsheet formulas carefully.");
		expect(skill.allowedTools).toEqual(["read_file", "write_file"]);
		expect(skill.description).toBe("Spreadsheet helper");
		expect(skill.whenToUse).toBe("When editing spreadsheets");
		expect(skill.arguments).toEqual(["path"]);
		expect(skill.argumentHint).toBe("Workbook path");
		expect(skill.model).toBe("openai/gpt-5.5");
		expect(skill.packageManifest).toEqual({ files: [{ path: "SKILL.md" }] });
		expect(skill.skillName).toBe("spreadsheet-helper");
		expect(skill.version).toBe("2");
	});

	it("keeps the resolver behind application ports for skill hydration", () => {
		const source = readFileSync(new URL("./resolver.ts", import.meta.url), "utf8");

		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("$lib/server/agents/registry");
		expect(source).not.toContain("./registry");
		expect(source).not.toContain("./registry-sync");
		expect(source).not.toContain("resolveCallableAgents");
		expect(source).toContain("workflowData.resolveSessionAgentByRef");
		expect(source).toContain("workflowData.resolvePeerAgentDispatchContext");
	});

	it("keeps environment runtime resolution behind the application service", () => {
		const source = readFileSync(new URL("./resolver.ts", import.meta.url), "utf8");

		expect(source).toContain("environments.resolveRuntimeByRef");
		expect(source).not.toContain("$lib/server/environments/registry");
		expect(source).not.toContain("resolveEnvironmentRef");
	});

	it("stamps a shared runtime-pool app id when pool routing is enabled", async () => {
		process.env.AGENT_RUNTIME_SHARED_POOLS_ENABLED = "true";
		process.env.AGENT_RUNTIME_POOL_APP_IDS_JSON = JSON.stringify({
			coding: "agent-runtime-pool-coding",
		});
		resolveSessionAgentByRefMock.mockResolvedValueOnce(
			resolvedAgent({ slug: "code-agent", config: minimalConfig() }),
		);
		const spec = specWithTasks([
			{
				Run: {
					call: "durable/run",
					with: {
						body: {
							prompt: "hello",
							agentRef: { id: "a1" },
						},
					},
				},
			},
		]);

		const resolved = await resolveSpecAgentRefs(spec);
		const task = (resolved.document as Record<string, unknown>).do as Array<
			Record<string, unknown>
		>;
		const withBlock = (task[0].Run as Record<string, unknown>).with as Record<
			string,
			unknown
		>;
		const body = withBlock.body as Record<string, unknown>;

		expect(body.agentAppId).toBe("agent-runtime-pool-coding");
		expect(body.agentSlug).toBe("code-agent");
		expect(body.agentRuntimeClass).toBe("coding");
		expect(body.agentRuntimeIsolation).toBe("shared");
		expect(withBlock.agentAppId).toBe("agent-runtime-pool-coding");
	});

	it("stamps the CLI adapter for interactive workflow runtimes", async () => {
		process.env.AGENT_RUNTIME_SHARED_POOLS_ENABLED = "true";
		process.env.AGENT_RUNTIME_POOL_APP_IDS_JSON = JSON.stringify({
			coding: "agent-runtime-pool-coding",
		});
		const config = minimalConfig({
			runtime: "codex-cli",
			runtimeIsolation: "shared",
			modelSpec: "openai/gpt-5.5",
			// Stale stored value should be corrected from the runtime registry.
			cliAdapter: "claude-code",
		});
		resolveSessionAgentByRefMock.mockResolvedValueOnce(
			resolvedAgent({
				slug: "codex-agent",
				config,
				runtimeAppId: "agent-runtime-pool-coding",
			}),
		);
		const spec = specWithTasks([
			{
				Run: {
					call: "durable/run",
					with: {
						body: {
							prompt: "hello",
							agentRef: { id: "a1" },
						},
					},
				},
			},
		]);

		const resolved = await resolveSpecAgentRefs(spec);
		const task = (resolved.document as Record<string, unknown>).do as Array<
			Record<string, unknown>
		>;
		const withBlock = (task[0].Run as Record<string, unknown>).with as Record<
			string,
			unknown
		>;
		const body = withBlock.body as Record<string, unknown>;
		expect((body.agentConfig as Record<string, unknown>).runtime).toBe("codex-cli");
		expect((body.agentConfig as Record<string, unknown>).cliAdapter).toBe("codex");
		expect((withBlock.agentConfig as Record<string, unknown>).cliAdapter).toBe(
			"codex",
		);
		expect(body.agentAppId).toBe("agent-runtime-codex-agent");
		expect(body.agentRuntimeIsolation).toBe("dedicated");
		expect(String(body.agentRuntimeRouteReason)).toContain(
			"per-session interactive CLI workflow host",
		);
	});

	it("resolves an agentRef slug from validated trigger input", async () => {
		const config = minimalConfig({
			runtime: "claude-code-cli",
			modelSpec: "anthropic/claude-opus-4-8",
		});
		resolveSessionAgentByRefMock.mockResolvedValueOnce(
			resolvedAgent({ slug: "claude-code-cli", config }),
		);
		const spec = specWithTasks([
			{
				Run: {
					call: "durable/run",
					with: {
						body: {
							prompt: "hello",
							agentRef: { slug: "${ .trigger.cliRuntime }" },
						},
					},
				},
			},
		]);

		const resolved = await resolveSpecAgentRefs(spec, {
			triggerData: { cliRuntime: "claude-code-cli" },
		});

		expect(resolveSessionAgentByRefMock).toHaveBeenCalledWith({
			slug: "claude-code-cli",
		});
		const task = (resolved.document as Record<string, unknown>).do as Array<
			Record<string, unknown>
		>;
		const body = ((task[0].Run as Record<string, unknown>).with as Record<string, unknown>)
			.body as Record<string, unknown>;
		expect(body.agentSlug).toBe("claude-code-cli");
		expect((body.agentConfig as Record<string, unknown>).runtime).toBe(
			"claude-code-cli",
		);
	});

	it("resolves an agentRef slug expression fallback when trigger input is omitted", async () => {
		resolveSessionAgentByRefMock.mockResolvedValueOnce(
			resolvedAgent({ slug: "codex-cli", config: minimalConfig({ runtime: "codex-cli" }) }),
		);
		const spec = specWithTasks([
			{
				Run: {
					call: "durable/run",
					with: {
						body: {
							prompt: "hello",
							agentRef: { slug: '${ .trigger.cliRuntime // "codex-cli" }' },
						},
					},
				},
			},
		]);

		const resolved = await resolveSpecAgentRefs(spec, {
			triggerData: {},
		});

		expect(resolveSessionAgentByRefMock).toHaveBeenCalledWith({ slug: "codex-cli" });
		const task = (resolved.document as Record<string, unknown>).do as Array<
			Record<string, unknown>
		>;
		const body = ((task[0].Run as Record<string, unknown>).with as Record<string, unknown>)
			.body as Record<string, unknown>;
		expect(body.agentSlug).toBe("codex-cli");
		expect((body.agentConfig as Record<string, unknown>).runtime).toBe("codex-cli");
	});

	it("resolves a whole agentRef from trigger input with fallback", async () => {
		resolveSessionAgentByRefMock.mockResolvedValueOnce(
			resolvedAgent({ slug: "codex-cli", config: minimalConfig({ runtime: "codex-cli" }) }),
		);
		const spec = specWithTasks([
			{
				Run: {
					call: "durable/run",
					with: {
						body: {
							prompt: "hello",
							agentRef: "${ .trigger.agentRef // .trigger.cliRuntime }",
						},
					},
				},
			},
		]);

		await resolveSpecAgentRefs(spec, {
			triggerData: { cliRuntime: "codex-cli" },
		});

		expect(resolveSessionAgentByRefMock).toHaveBeenCalledWith({
			slug: "codex-cli",
		});
	});

	it("fails closed on unsupported dynamic agentRef expressions", async () => {
		const spec = specWithTasks([
			{
				Run: {
					call: "durable/run",
					with: {
						body: {
							prompt: "hello",
							agentRef: { slug: "${ .trigger.cliRuntime | ascii_downcase }" },
						},
					},
				},
			},
		]);

		await expect(
			resolveSpecAgentRefs(spec, { triggerData: { cliRuntime: "codex-cli" } }),
		).rejects.toThrow(/unsupported agentRef expression/);
	});

	it("throws AgentRefResolutionError when agentRef is missing on a durable/run task", async () => {
		const spec = specWithTasks([
			{ Run: { call: "durable/run", with: { body: { prompt: "hi" } } } },
		]);
		await expect(resolveSpecAgentRefs(spec)).rejects.toBeInstanceOf(
			AgentRefResolutionError,
		);
	});

	it("throws when the referenced agent is not found", async () => {
		resolveSessionAgentByRefMock.mockResolvedValueOnce(null);
		const spec = specWithTasks([
			{
				Run: {
					call: "durable/run",
					with: { body: { agentRef: { id: "missing" } } },
				},
			},
		]);
		await expect(resolveSpecAgentRefs(spec)).rejects.toBeInstanceOf(
			AgentRefResolutionError,
		);
	});

	it("applies overrides on top of the resolved config + environment", async () => {
		const config = minimalConfig({
			modelSpec: "x",
			maxTurns: 100,
			timeoutMinutes: 30,
		});
		resolveSessionAgentByRefMock.mockResolvedValueOnce(
			resolvedAgent({
				slug: "s",
				config,
				environmentId: "env_1",
				environmentVersion: 1,
			}),
		);
		resolveRuntimeByRefMock.mockResolvedValueOnce({
			environment: {
				id: "env_1",
				slug: "dev",
				version: 1,
				config: minimalEnv({ sandboxMode: "per-run" }),
			},
		});
		const spec = specWithTasks([
			{
				Run: {
					call: "durable/run",
					with: {
						body: {
							prompt: "p",
							agentRef: { id: "a1" },
							overrides: {
								maxTurns: 5,
								tools: ["read_file"],
								sandboxPolicy: { mode: "shared-runtime" },
							},
						},
					},
				},
			},
		]);
		const resolved = await resolveSpecAgentRefs(spec);
		const task = (resolved.document as Record<string, unknown>).do as Array<
			Record<string, unknown>
		>;
		const body = ((task[0].Run as Record<string, unknown>).with as Record<string, unknown>)
			.body as Record<string, unknown>;
		const inlined = body.agentConfig as AgentConfig;
		expect(inlined.maxTurns).toBe(5);
		expect(inlined.tools).toEqual(["read_file"]);
		expect(body.overrides).toBeUndefined();
		// sandbox override merged onto env-derived policy
		expect((body.sandboxPolicy as Record<string, unknown>).mode).toBe(
			"shared-runtime",
		);
		expect((body.sandboxPolicy as Record<string, unknown>).template).toBe(
			"dapr-agent",
		);
	});

	it("caches repeated refs within a single spec", async () => {
		resolveSessionAgentByRefMock.mockResolvedValue(resolvedAgent({ slug: "s" }));
		const spec = specWithTasks([
			{ A: { call: "durable/run", with: { body: { agentRef: { id: "a1" } } } } },
			{ B: { call: "durable/run", with: { body: { agentRef: { id: "a1" } } } } },
			{ C: { call: "durable/run", with: { body: { agentRef: { id: "a1" } } } } },
		]);
		await resolveSpecAgentRefs(spec);
		expect(resolveSessionAgentByRefMock).toHaveBeenCalledTimes(1);
	});

	it("does not mutate the input spec", async () => {
		resolveSessionAgentByRefMock.mockResolvedValueOnce(resolvedAgent({ slug: "s" }));
		const spec = specWithTasks([
			{
				Run: {
					call: "durable/run",
					with: { body: { prompt: "p", agentRef: { id: "a1" } } },
				},
			},
		]);
		const snapshot = JSON.stringify(spec);
		await resolveSpecAgentRefs(spec);
		expect(JSON.stringify(spec)).toBe(snapshot);
	});

	it("resolves environmentRef from the agent and inlines a derived sandboxPolicy", async () => {
		resolveSessionAgentByRefMock.mockResolvedValueOnce(
			resolvedAgent({
				environmentId: "env_1",
				environmentVersion: 2,
			}),
		);
		resolveRuntimeByRefMock.mockResolvedValueOnce({
			environment: {
				id: "env_1",
				slug: "dev-sandbox",
				version: 2,
				config: minimalEnv({
					sandboxTemplate: "dapr-agent-xlsx",
					sandboxMode: "per-node",
					keepAfterRun: true,
					ttlSeconds: 3600,
				}),
			},
		});
		const spec = specWithTasks([
			{
				Run: {
					call: "durable/run",
					with: { body: { prompt: "hi", agentRef: { id: "a1" } } },
				},
			},
		]);
		const resolved = await resolveSpecAgentRefs(spec);
		const task = (resolved.document as Record<string, unknown>).do as Array<
			Record<string, unknown>
		>;
		const withBlock = (task[0].Run as Record<string, unknown>).with as Record<
			string,
			unknown
		>;
		const body = withBlock.body as Record<string, unknown>;
		expect(resolveRuntimeByRefMock).toHaveBeenCalledWith({
			id: "env_1",
			version: 2,
		});
		expect(body.environment).toMatchObject({
			id: "env_1",
			slug: "dev-sandbox",
			version: 2,
		});
		const sandboxPolicy = body.sandboxPolicy as Record<string, unknown>;
		expect(sandboxPolicy.mode).toBe("per-node");
		expect(sandboxPolicy.template).toBe("dapr-agent-xlsx");
		expect(sandboxPolicy.keepAfterRun).toBe(true);
		expect(sandboxPolicy.ttlSeconds).toBe(3600);
		expect(body.environmentRef).toBeUndefined();
	});

	it("prefers explicit body.environmentRef over the agent's default environment", async () => {
		resolveSessionAgentByRefMock.mockResolvedValueOnce(
			resolvedAgent({ environmentId: "env_default", environmentVersion: 1 }),
		);
		resolveRuntimeByRefMock.mockResolvedValueOnce({
			environment: {
				id: "env_override",
				slug: "prod",
				version: 7,
				config: minimalEnv({ sandboxMode: "shared-runtime" }),
			},
		});
		const spec = specWithTasks([
			{
				Run: {
					call: "durable/run",
					with: {
						body: {
							agentRef: { id: "a1" },
							environmentRef: { id: "env_override", version: 7 },
						},
					},
				},
			},
		]);
		await resolveSpecAgentRefs(spec);
		expect(resolveRuntimeByRefMock).toHaveBeenCalledWith({
			id: "env_override",
			version: 7,
		});
	});

	it("throws when the agent's environmentRef resolves to nothing", async () => {
		resolveSessionAgentByRefMock.mockResolvedValueOnce(
			resolvedAgent({ environmentId: "env_missing", environmentVersion: 1 }),
		);
		resolveRuntimeByRefMock.mockResolvedValueOnce({ environment: null });
		const spec = specWithTasks([
			{
				Run: {
					call: "durable/run",
					with: { body: { agentRef: { id: "a1" } } },
				},
			},
		]);
		await expect(resolveSpecAgentRefs(spec)).rejects.toBeInstanceOf(
			AgentRefResolutionError,
		);
	});
});

describe("assertConsistentWorkspaceBackends (cross-backend file-sharing guard)", () => {
	it("rejects mixing interactive-cli + openshell on a shared workspaceRef", () => {
		expect(() =>
			assertConsistentWorkspaceBackends([
				{ taskName: "plan", runtime: "dapr-agent-py", workspaceRef: "${ .runtime.executionId }" },
				{ taskName: "generate", runtime: "codex-cli", workspaceRef: "${ .runtime.executionId }" },
			]),
		).toThrow(WorkspaceBackendMismatchError);
	});

	it("allows mixing different agents within the SAME backend (all interactive-cli)", () => {
		expect(() =>
			assertConsistentWorkspaceBackends([
				{ taskName: "plan", runtime: "claude-code-cli", workspaceRef: "${ .runtime.executionId }" },
				{ taskName: "generate", runtime: "codex-cli", workspaceRef: "${ .runtime.executionId }" },
				{ taskName: "critic", runtime: "agy-cli", workspaceRef: "${ .runtime.executionId }" },
			]),
		).not.toThrow();
	});

	it("allows different backends when they do NOT share a workspaceRef", () => {
		expect(() =>
			assertConsistentWorkspaceBackends([
				{ taskName: "a", runtime: "dapr-agent-py", workspaceRef: "ws-a" },
				{ taskName: "b", runtime: "codex-cli", workspaceRef: "ws-b" },
			]),
		).not.toThrow();
	});

	it("allows all-openshell (dapr + browser-use) on a shared workspaceRef", () => {
		expect(() =>
			assertConsistentWorkspaceBackends([
				{ taskName: "plan", runtime: "dapr-agent-py", workspaceRef: "shared" },
				{ taskName: "gen", runtime: "browser-use-agent", workspaceRef: "shared" },
			]),
		).not.toThrow();
	});
});

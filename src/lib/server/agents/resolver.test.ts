import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveAgentRefMock = vi.fn();
vi.mock("./registry", () => ({
	resolveAgentRef: (...args: unknown[]) => resolveAgentRefMock(...args),
}));

const resolveEnvironmentRefMock = vi.fn();
vi.mock("$lib/server/environments/registry", () => ({
	resolveEnvironmentRef: (...args: unknown[]) =>
		resolveEnvironmentRefMock(...args),
}));

import {
	AgentRefResolutionError,
	collectDurableRunTasks,
	resolveSpecAgentRefs,
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
		...overrides,
	};
}

describe("resolveSpecAgentRefs", () => {
	beforeEach(() => {
		resolveAgentRefMock.mockReset();
		resolveEnvironmentRefMock.mockReset();
	});

	it("inlines resolved agentConfig and strips agentRef", async () => {
		const config = minimalConfig({ modelSpec: "anthropic/claude-opus-4-7" });
		resolveAgentRefMock.mockResolvedValueOnce(
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
		expect(body.agentId).toBe("a1");
		expect(body.agentVersion).toBe(3);
		expect(body.agentAppId).toBe("agent-runtime-code-agent");
		expect(body.agentSlug).toBe("code-agent");
		expect(body.prompt).toBe("hello");
		expect(withBlock.agentRef).toBeUndefined();
		expect(withBlock.agentConfig).toEqual(config);
		expect(withBlock.agentRuntime).toBe("dapr-agent-py");
		expect(withBlock.agentId).toBe("a1");
		expect(withBlock.agentVersion).toBe(3);
		expect(withBlock.agentAppId).toBe("agent-runtime-code-agent");
		expect(withBlock.agentSlug).toBe("code-agent");
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
		resolveAgentRefMock.mockResolvedValueOnce(null);
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
		resolveAgentRefMock.mockResolvedValueOnce(
			resolvedAgent({
				slug: "s",
				config,
				environmentId: "env_1",
				environmentVersion: 1,
			}),
		);
		resolveEnvironmentRefMock.mockResolvedValueOnce({
			id: "env_1",
			slug: "dev",
			version: 1,
			config: minimalEnv({ sandboxMode: "per-run" }),
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
		resolveAgentRefMock.mockResolvedValue(resolvedAgent({ slug: "s" }));
		const spec = specWithTasks([
			{ A: { call: "durable/run", with: { body: { agentRef: { id: "a1" } } } } },
			{ B: { call: "durable/run", with: { body: { agentRef: { id: "a1" } } } } },
			{ C: { call: "durable/run", with: { body: { agentRef: { id: "a1" } } } } },
		]);
		await resolveSpecAgentRefs(spec);
		expect(resolveAgentRefMock).toHaveBeenCalledTimes(1);
	});

	it("does not mutate the input spec", async () => {
		resolveAgentRefMock.mockResolvedValueOnce(resolvedAgent({ slug: "s" }));
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
		resolveAgentRefMock.mockResolvedValueOnce(
			resolvedAgent({
				environmentId: "env_1",
				environmentVersion: 2,
			}),
		);
		resolveEnvironmentRefMock.mockResolvedValueOnce({
			id: "env_1",
			slug: "dev-sandbox",
			version: 2,
			config: minimalEnv({
				sandboxTemplate: "dapr-agent-xlsx",
				sandboxMode: "per-node",
				keepAfterRun: true,
				ttlSeconds: 3600,
			}),
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
		expect(resolveEnvironmentRefMock).toHaveBeenCalledWith({
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
		resolveAgentRefMock.mockResolvedValueOnce(
			resolvedAgent({ environmentId: "env_default", environmentVersion: 1 }),
		);
		resolveEnvironmentRefMock.mockResolvedValueOnce({
			id: "env_override",
			slug: "prod",
			version: 7,
			config: minimalEnv({ sandboxMode: "shared-runtime" }),
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
		expect(resolveEnvironmentRefMock).toHaveBeenCalledWith({
			id: "env_override",
			version: 7,
		});
	});

	it("throws when the agent's environmentRef resolves to nothing", async () => {
		resolveAgentRefMock.mockResolvedValueOnce(
			resolvedAgent({ environmentId: "env_missing", environmentVersion: 1 }),
		);
		resolveEnvironmentRefMock.mockResolvedValueOnce(null);
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

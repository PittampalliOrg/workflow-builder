import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$env/dynamic/private", () => ({ env: process.env }));

import { compileAgentApplicationState } from "./application-state";

function agent(overrides: Record<string, unknown> = {}) {
	return {
		id: "agent_1",
		slug: "code-agent",
		name: "Code Agent",
		description: null,
		avatar: null,
		tags: [],
		runtime: "dapr-agent-py",
		runtimeAppId: null,
		runtimeStatus: "pending",
		runtimeStatusSyncedAt: null,
		currentVersionId: "agent_version_1",
		environmentId: "env_1",
		environmentVersion: 2,
		defaultVaultIds: [],
		sourceTemplateSlug: null,
		sourceTemplateVersion: null,
		createdBy: "user_1",
		projectId: "project_1",
		isArchived: false,
		registryStatus: "registered",
		registrySyncedAt: null,
		registryError: null,
		createdAt: new Date("2026-05-14T12:00:00Z"),
		updatedAt: new Date("2026-05-14T12:00:00Z"),
		...overrides,
	} as any;
}

function version(configOverrides: Record<string, unknown> = {}) {
	return {
		id: "agent_version_1",
		agentId: "agent_1",
		version: 1,
		config: {
			systemPrompt: "You write code.",
			modelSpec: "anthropic/claude-opus-4-7",
			builtinTools: ["read_file", "edit_file"],
			tools: ["grep_search"],
			mcpConnectionMode: "explicit",
			mcpServers: [{ server_name: "github", displayName: "GitHub" }],
			skills: [{ id: "testing", version: "1.0.0" }],
			plugins: ["reviewer"],
			callableAgents: ["peer"],
			runtime: "dapr-agent-py",
			runtimeOverridePolicy: {},
			staticPromptPresetRefs: [{ id: "prompt_1", version: 3 }],
			promptPresetManifest: [
				{
					promptId: "prompt_1",
					version: 3,
					promptVersionId: "prompt_version_1",
					mlflowUri: "prompts:/coding/3",
				},
			],
			...configOverrides,
		},
		configHash: "config_hash_1",
		applicationStateDigest: null,
		mlflowUri: null,
		mlflowModelName: null,
		mlflowModelVersion: null,
		changelog: null,
		publishedAt: new Date("2026-05-14T12:01:00Z"),
		publishedBy: "user_1",
		createdAt: new Date("2026-05-14T12:01:00Z"),
	} as any;
}

describe("compileAgentApplicationState", () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
		vi.stubEnv("WORKFLOW_BUILDER_ENV", "ryzen");
		vi.stubEnv("GIT_SHA", "abc123");
		vi.stubEnv("AGENT_RUNTIME_DEFAULT_IMAGE", "ghcr.io/acme/dapr-agent-py@sha256:abcd");
	});

	it("produces a stable digest for identical application state", () => {
		const first = compileAgentApplicationState({
			agent: agent(),
			version: version(),
		});
		const second = compileAgentApplicationState({
			agent: agent(),
			version: version(),
		});

		expect(first.stateDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(second.stateDigest).toBe(first.stateDigest);
		expect(first.manifest.dapr.metadata.agent.appid).toBe(
			"agent-runtime-code-agent",
		);
		expect(first.manifest.prompts.presetManifest?.[0]?.mlflowUri).toBe(
			"prompts:/coding/3",
		);
		expect(first.manifest.tools.mcpServers).toHaveLength(1);
		expect(first.manifest.source.build.workflowBuilderGitSha).toBe("abc123");
	});

	it("changes the digest when prompt, tool, runtime, or source state changes", () => {
		const base = compileAgentApplicationState({
			agent: agent(),
			version: version(),
		}).stateDigest;
		const prompt = compileAgentApplicationState({
			agent: agent(),
			version: version({ systemPrompt: "A different prompt." }),
		}).stateDigest;
		const tools = compileAgentApplicationState({
			agent: agent(),
			version: version({ builtinTools: ["read_file"] }),
		}).stateDigest;
		const runtime = compileAgentApplicationState({
			agent: agent({ runtime: "adk-agent-py" }),
			version: version({ runtime: "adk-agent-py" }),
		}).stateDigest;
		vi.stubEnv("GIT_SHA", "def456");
		const source = compileAgentApplicationState({
			agent: agent(),
			version: version(),
		}).stateDigest;

		expect(new Set([base, prompt, tools, runtime, source]).size).toBe(5);
	});
});

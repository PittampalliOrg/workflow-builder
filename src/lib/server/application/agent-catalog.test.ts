import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	ApplicationAgentCatalogService,
	type CreateAgentResult,
} from "$lib/server/application/agent-catalog";
import type {
	AgentCatalogRepository,
	AgentRuntimeCatalog,
	AgentTemplateCatalog,
} from "$lib/server/application/ports";
import type { AgentConfig, AgentDetail } from "$lib/types/agents";

describe("ApplicationAgentCatalogService", () => {
	let agents: AgentCatalogRepository;
	let runtimes: AgentRuntimeCatalog;
	let templates: AgentTemplateCatalog;
	let service: ApplicationAgentCatalogService;

	beforeEach(() => {
		agents = fakeAgentCatalogRepository();
		runtimes = {
			listRuntimeIds: vi.fn(() => ["dapr-agent-py", "codex-cli", "agy-cli"]),
		};
		templates = {
			resolveAgentTemplateConfig: vi.fn(() => null),
		};
		service = new ApplicationAgentCatalogService({
			agents,
			runtimes,
			templates,
		});
	});

	it("lists agents with workspace project defaults and explicit null project opt-out", async () => {
		await service.listAgents({
			currentProjectId: "project-1",
			query: {
				q: "writer",
				tag: "draft",
				includeArchived: "true",
				includeEphemeral: "false",
				projectId: null,
			},
		});
		await service.listAgents({
			currentProjectId: "project-1",
			query: { projectId: "null" },
		});

		expect(agents.listAgents).toHaveBeenNthCalledWith(1, {
			q: "writer",
			tag: "draft",
			includeArchived: true,
			includeEphemeral: false,
			projectId: "project-1",
		});
		expect(agents.listAgents).toHaveBeenNthCalledWith(2, {
			q: undefined,
			tag: undefined,
			includeArchived: false,
			includeEphemeral: false,
			projectId: undefined,
		});
	});

	it("creates agents from template config, request patch, and valid runtime", async () => {
		vi.mocked(templates.resolveAgentTemplateConfig).mockReturnValueOnce(
			sampleAgentConfig("codex-cli", "openai/gpt-5.5"),
		);

		const result = await service.createAgent({
			userId: "user-1",
			currentProjectId: "project-1",
			templateSlug: "quickstart",
			body: {
				name: " Writer ",
				description: "Drafts things",
				tags: ["draft", 123],
				runtime: "agy-cli",
				config: { maxTurns: 5 },
			},
		});

		expect(result.status).toBe("created");
		expect(agents.createAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "Writer",
				description: "Drafts things",
				tags: ["draft", "123"],
				runtime: "agy-cli",
				sourceTemplateSlug: "quickstart",
				sourceTemplateVersion: 1,
				createdBy: "user-1",
				projectId: "project-1",
				config: expect.objectContaining({
					runtime: "codex-cli",
					modelSpec: "openai/gpt-5.5",
					maxTurns: 5,
				}),
			}),
		);
	});

	it("defaults invalid create runtimes and maps invalid config errors", async () => {
		vi.mocked(agents.createAgent).mockResolvedValueOnce({
			ok: false,
			reason: "invalid_config",
			message: "bad config",
		});

		const result = await service.createAgent({
			userId: "user-1",
			currentProjectId: null,
			templateSlug: null,
			body: { name: "", runtime: "missing-runtime" },
		});

		expect(result).toEqual<CreateAgentResult>({
			status: "invalid",
			message: "bad config",
		});
		expect(agents.createAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "Untitled Agent",
				runtime: "dapr-agent-py",
				projectId: null,
			}),
		);
	});

	it("updates agents through the repository and maps not-found and invalid results", async () => {
		await service.updateAgent({
			agentId: "agent-1",
			userId: "user-1",
			body: {
				name: "Updated",
				runtime: "codex-cli",
				defaultVaultIds: ["vault-1", 2],
				config: { runtime: "codex-cli" },
			},
		});
		vi.mocked(agents.updateAgent).mockResolvedValueOnce({
			ok: false,
			reason: "not_found",
		});
		vi.mocked(agents.updateAgent).mockResolvedValueOnce({
			ok: false,
			reason: "invalid_config",
			message: "bad config",
		});

		const notFound = await service.updateAgent({
			agentId: "missing",
			userId: "user-1",
			body: {},
		});
		const invalid = await service.updateAgent({
			agentId: "agent-1",
			userId: "user-1",
			body: {},
		});

		expect(agents.updateAgent).toHaveBeenNthCalledWith(
			1,
			"agent-1",
			expect.objectContaining({
				name: "Updated",
				runtime: "codex-cli",
				defaultVaultIds: ["vault-1", "2"],
				config: { runtime: "codex-cli" },
				publishedBy: "user-1",
			}),
		);
		expect(notFound).toEqual({
			status: "not_found",
			message: "Agent not found",
		});
		expect(invalid).toEqual({ status: "invalid", message: "bad config" });
	});

	it("duplicates agents with session ownership metadata", async () => {
		const result = await service.duplicateAgent({
			agentId: "agent-1",
			userId: "user-1",
			currentProjectId: "project-1",
			body: {
				name: "Copy",
				description: "Copy description",
			},
		});

		expect(result.status).toBe("created");
		expect(agents.duplicateAgent).toHaveBeenCalledWith("agent-1", {
			name: "Copy",
			description: "Copy description",
			createdBy: "user-1",
			projectId: "project-1",
		});
	});

	it("parses version numbers and maps get/restore failures", async () => {
		vi.mocked(agents.getVersion).mockResolvedValueOnce({
			summary: sampleVersion(),
			config: sampleAgentConfig(),
		});
		vi.mocked(agents.restoreVersion).mockResolvedValueOnce(null);

		const invalid = await service.getVersion({
			agentId: "agent-1",
			version: "nope",
		});
		const found = await service.getVersion({
			agentId: "agent-1",
			version: "2",
		});
		const restoreMissing = await service.restoreVersion({
			agentId: "agent-1",
			version: "3",
			userId: "user-1",
		});

		expect(invalid).toEqual({ status: "invalid", message: "Invalid version" });
		expect(found.status).toBe("ok");
		expect(agents.getVersion).toHaveBeenCalledWith("agent-1", 2);
		expect(restoreMissing).toEqual({
			status: "not_found",
			message: "Version not found",
		});
		expect(agents.restoreVersion).toHaveBeenCalledWith("agent-1", 3, "user-1");
	});

	it("delegates usage read models to the repository", async () => {
		await service.findAgentUsages("agent-1");
		await service.findAllAgentUsageCounts();

		expect(agents.findAgentUsages).toHaveBeenCalledWith("agent-1");
		expect(agents.findAllAgentUsageCounts).toHaveBeenCalled();
	});
});

function fakeAgentCatalogRepository(): AgentCatalogRepository {
	return {
		listAgents: vi.fn(async () => []),
		getAgent: vi.fn(async () => sampleAgent()),
		createAgent: vi.fn(async () => ({ ok: true as const, agent: sampleAgent() })),
		updateAgent: vi.fn(async () => ({ ok: true as const, agent: sampleAgent() })),
		archiveAgent: vi.fn(async () => true),
		duplicateAgent: vi.fn(async () => sampleAgent()),
		listVersions: vi.fn(async () => [sampleVersion()]),
		getVersion: vi.fn(async () => ({
			summary: sampleVersion(),
			config: sampleAgentConfig(),
		})),
		restoreVersion: vi.fn(async () => sampleAgent()),
		findAgentUsages: vi.fn(async () => [
			{ workflowId: "workflow-1", workflowName: "Workflow", nodeIds: ["run"] },
		]),
		findAllAgentUsageCounts: vi.fn(async () => ({
			"agent-1": { workflowCount: 1, nodeCount: 1 },
		})),
	};
}

function sampleAgentConfig(
	runtime: AgentConfig["runtime"] = "dapr-agent-py",
	modelSpec = "openai/gpt-5.5",
): AgentConfig {
	return {
		runtime,
		modelSpec,
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
	};
}

function sampleAgent(): AgentDetail {
	return {
		id: "agent-1",
		slug: "writer",
		name: "Writer",
		description: null,
		avatar: null,
		tags: [],
		runtime: "dapr-agent-py",
		currentVersion: 1,
		currentConfigHash: "hash",
		modelSpec: null,
		environmentId: null,
		environmentVersion: null,
		defaultVaultIds: [],
		isArchived: false,
		registryStatus: "registered",
		registrySyncedAt: null,
		registryError: null,
		createdAt: "2026-05-15T12:00:00.000Z",
		updatedAt: "2026-05-15T12:00:00.000Z",
		config: sampleAgentConfig(),
		sourceTemplateSlug: null,
		sourceTemplateVersion: null,
	};
}

function sampleVersion() {
	return {
		id: "version-1",
		agentId: "agent-1",
		version: 2,
		configHash: "hash-2",
		applicationStateDigest: null,
		mlflowUri: null,
		mlflowModelName: null,
		mlflowModelVersion: null,
		changelog: null,
		publishedAt: "2026-05-15T12:00:00.000Z",
		publishedBy: "user-1",
		createdAt: "2026-05-15T12:00:00.000Z",
	};
}

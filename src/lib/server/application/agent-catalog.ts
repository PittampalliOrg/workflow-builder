import { createDefaultAgentConfig } from "$lib/types/agents";
import type { AgentConfig, AgentDetail, AgentRuntime } from "$lib/types/agents";
import type {
	AgentCatalogVersionDetail,
	AgentCatalogRepository,
	AgentCompiledCapabilities,
	AgentCompiledCapabilitiesRepository,
	AgentRegistryRepository,
	AgentRegistrySyncResult,
	AgentRegistryView,
	AgentRuntimeCatalog,
	AgentTemplateCatalog,
} from "$lib/server/application/ports";

export type ListAgentsCommand = {
	query: {
		q?: string | null;
		tag?: string | null;
		includeArchived?: string | null;
		includeEphemeral?: string | null;
		projectId?: string | null;
	};
	currentProjectId?: string | null;
};

export type CreateAgentCommand = {
	userId: string;
	currentProjectId?: string | null;
	templateSlug?: string | null;
	body: Record<string, unknown>;
};

export type UpdateAgentCommand = {
	agentId: string;
	userId: string;
	body: Record<string, unknown>;
};

export type DuplicateAgentCommand = {
	agentId: string;
	userId: string;
	currentProjectId?: string | null;
	body: Record<string, unknown>;
};

export type AgentVersionCommand = {
	agentId: string;
	version: string;
	userId?: string | null;
};

export type GetAgentResult =
	| { status: "ok"; agent: AgentDetail }
	| { status: "not_found"; message: string };

export type CreateAgentResult =
	| { status: "created"; agent: AgentDetail }
	| { status: "invalid"; message: string };

export type UpdateAgentResult =
	| { status: "updated"; agent: AgentDetail }
	| { status: "not_found"; message: string }
	| { status: "invalid"; message: string };

export type ArchiveAgentResult =
	| { status: "archived" }
	| { status: "not_found"; message: string };

export type DuplicateAgentResult =
	| { status: "created"; agent: AgentDetail }
	| { status: "not_found"; message: string };

export type AgentVersionResult =
	| { status: "ok"; version: AgentCatalogVersionDetail }
	| { status: "invalid"; message: string }
	| { status: "not_found"; message: string };

export type RestoreAgentVersionResult =
	| { status: "restored"; agent: AgentDetail }
	| { status: "invalid"; message: string }
	| { status: "not_found"; message: string };

export type CompiledCapabilitiesResult =
	| { status: "ok"; compiled: AgentCompiledCapabilities }
	| { status: "not_found"; message: string };

export type AgentRegistryStatusResult =
	| { status: "ok"; view: AgentRegistryView }
	| { status: "not_found"; message: string };

export class ApplicationAgentCatalogService {
	constructor(
		private readonly deps: {
			agents: AgentCatalogRepository;
			capabilities: AgentCompiledCapabilitiesRepository;
			registry: AgentRegistryRepository;
			runtimes: AgentRuntimeCatalog;
			templates: AgentTemplateCatalog;
		},
	) {}

	listAgents(input: ListAgentsCommand) {
		const projectIdParam = input.query.projectId;
		const projectId =
			projectIdParam === "null"
				? undefined
				: projectIdParam
					? projectIdParam
					: (input.currentProjectId ?? undefined);
		return this.deps.agents.listAgents({
			q: input.query.q ?? undefined,
			tag: input.query.tag ?? undefined,
			includeArchived: input.query.includeArchived === "true",
			includeEphemeral: input.query.includeEphemeral === "true",
			projectId,
		});
	}

	async getAgent(agentId: string): Promise<GetAgentResult> {
		const agent = await this.deps.agents.getAgent(agentId);
		if (!agent) return { status: "not_found", message: "Agent not found" };
		return { status: "ok", agent };
	}

	async createAgent(input: CreateAgentCommand): Promise<CreateAgentResult> {
		const templateSlug = input.templateSlug ?? null;
		const baseConfig =
			this.deps.templates.resolveAgentTemplateConfig(templateSlug) ??
			createDefaultAgentConfig();
		const config = mergeConfig(baseConfig, input.body.config);
		const runtime =
			this.pickRuntime(input.body.runtime) ??
			this.pickRuntime(baseConfig.runtime) ??
			"dapr-agent-py";
		const result = await this.deps.agents.createAgent({
			slug: typeof input.body.slug === "string" ? input.body.slug : undefined,
			name:
				typeof input.body.name === "string" && input.body.name.trim()
					? input.body.name.trim()
					: "Untitled Agent",
			description:
				typeof input.body.description === "string"
					? input.body.description
					: null,
			avatar:
				typeof input.body.avatar === "string" ? input.body.avatar : null,
			tags: Array.isArray(input.body.tags)
				? input.body.tags.map((t) => String(t))
				: undefined,
			runtime,
			sourceTemplateSlug: templateSlug,
			sourceTemplateVersion: templateSlug ? 1 : null,
			createdBy: input.userId,
			projectId:
				typeof input.body.projectId === "string"
					? input.body.projectId
					: (input.currentProjectId ?? null),
			config,
		});
		if (!result.ok) return { status: "invalid", message: result.message };
		return { status: "created", agent: result.agent };
	}

	async updateAgent(input: UpdateAgentCommand): Promise<UpdateAgentResult> {
		const body = input.body;
		const result = await this.deps.agents.updateAgent(input.agentId, {
			name: typeof body.name === "string" ? body.name : undefined,
			description:
				typeof body.description === "string" || body.description === null
					? (body.description as string | null)
					: undefined,
			avatar:
				typeof body.avatar === "string" || body.avatar === null
					? (body.avatar as string | null)
					: undefined,
			tags: Array.isArray(body.tags) ? body.tags.map((t) => String(t)) : undefined,
			runtime: this.pickRuntime(body.runtime),
			environmentId:
				typeof body.environmentId === "string" || body.environmentId === null
					? (body.environmentId as string | null)
					: undefined,
			environmentVersion:
				typeof body.environmentVersion === "number" ||
				body.environmentVersion === null
					? (body.environmentVersion as number | null)
					: undefined,
			defaultVaultIds: Array.isArray(body.defaultVaultIds)
				? body.defaultVaultIds.map((v) => String(v))
				: undefined,
			config:
				body.config && typeof body.config === "object"
					? (body.config as AgentConfig)
					: undefined,
			changelog: typeof body.changelog === "string" ? body.changelog : undefined,
			publishedBy: input.userId,
		});
		if (result.ok) return { status: "updated", agent: result.agent };
		if (result.reason === "not_found") {
			return { status: "not_found", message: "Agent not found" };
		}
		return { status: "invalid", message: result.message };
	}

	async archiveAgent(agentId: string): Promise<ArchiveAgentResult> {
		const archived = await this.deps.agents.archiveAgent(agentId);
		if (!archived) return { status: "not_found", message: "Agent not found" };
		return { status: "archived" };
	}

	async duplicateAgent(
		input: DuplicateAgentCommand,
	): Promise<DuplicateAgentResult> {
		const body = input.body;
		const agent = await this.deps.agents.duplicateAgent(input.agentId, {
			name: typeof body.name === "string" ? body.name : undefined,
			description:
				typeof body.description === "string" ? body.description : undefined,
			createdBy: input.userId,
			projectId: input.currentProjectId ?? null,
		});
		if (!agent) return { status: "not_found", message: "Agent not found" };
		return { status: "created", agent };
	}

	listVersions(agentId: string) {
		return this.deps.agents.listVersions(agentId);
	}

	async getVersion(input: AgentVersionCommand): Promise<AgentVersionResult> {
		const version = parseVersion(input.version);
		if (version === null) return { status: "invalid", message: "Invalid version" };
		const result = await this.deps.agents.getVersion(input.agentId, version);
		if (!result) return { status: "not_found", message: "Version not found" };
		return { status: "ok", version: result };
	}

	async restoreVersion(
		input: AgentVersionCommand,
	): Promise<RestoreAgentVersionResult> {
		const version = parseVersion(input.version);
		if (version === null) return { status: "invalid", message: "Invalid version" };
		const agent = await this.deps.agents.restoreVersion(
			input.agentId,
			version,
			input.userId,
		);
		if (!agent) return { status: "not_found", message: "Version not found" };
		return { status: "restored", agent };
	}

	findAgentUsages(agentId: string) {
		return this.deps.agents.findAgentUsages(agentId);
	}

	findAllAgentUsageCounts() {
		return this.deps.agents.findAllAgentUsageCounts();
	}

	async compileCapabilities(agentId: string): Promise<CompiledCapabilitiesResult> {
		const compiled = await this.deps.capabilities.compileAgentCapabilities(agentId);
		if (!compiled) return { status: "not_found", message: "Agent not found" };
		return { status: "ok", compiled };
	}

	async getRegistryStatus(input: {
		agentId: string;
		includeMetadata?: boolean;
	}): Promise<AgentRegistryStatusResult> {
		const view = await this.deps.registry.getRegistryStatus(input.agentId, {
			includeMetadata: input.includeMetadata,
		});
		if (!view) return { status: "not_found", message: "Agent not found" };
		return { status: "ok", view };
	}

	deregisterAgentRegistry(agentId: string): Promise<AgentRegistrySyncResult> {
		return this.deps.registry.deregisterAgent(agentId);
	}

	async syncAgentRegistry(agentId: string): Promise<AgentRegistrySyncResult> {
		const result = await this.deps.registry.registerAgent(agentId);
		await this.deps.registry.syncAgentRuntime(agentId);
		return result;
	}

	private pickRuntime(value: unknown): AgentRuntime | undefined {
		if (typeof value === "string" && this.deps.runtimes.listRuntimeIds().includes(value)) {
			return value as AgentRuntime;
		}
		return undefined;
	}
}

function mergeConfig(base: AgentConfig, patch: unknown): AgentConfig {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) return base;
	return { ...base, ...(patch as Partial<AgentConfig>) };
}

function parseVersion(value: string): number | null {
	const version = Number.parseInt(value, 10);
	return Number.isFinite(version) && version > 0 ? version : null;
}

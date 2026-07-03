import {
	parseAgentMarkdown,
	serializeAgentMarkdown,
} from "$lib/server/agents/markdown";
import type { AgentCatalogRepository } from "$lib/server/application/ports";

export type AgentImportExportEnvironmentRef = {
	id: string;
	slug: string;
	currentVersion?: number | null;
};

export type AgentImportExportVaultRef = {
	id: string;
	name: string;
};

export interface AgentImportExportReferenceRepository {
	listEnvironments(input: {
		includeArchived?: boolean;
	}): Promise<AgentImportExportEnvironmentRef[]>;
	listVaults(input: {
		includeArchived?: boolean;
	}): Promise<AgentImportExportVaultRef[]>;
	resolveEnvironmentSlug(input: {
		id: string;
		version?: number | null;
	}): Promise<string | null>;
}

export type ImportAgentResult =
	| { status: "created"; agent: unknown; warnings: string[] }
	| { status: "invalid"; message: string };

export type ExportAgentResult =
	| { status: "ok"; markdown: string; filename: string }
	| { status: "not_found"; message: string };

export class ApplicationAgentImportExportService {
	constructor(
		private readonly deps: {
			agents: Pick<AgentCatalogRepository, "createAgent" | "getAgent">;
			references: AgentImportExportReferenceRepository;
		},
	) {}

	async importAgent(input: {
		source: string;
		userId: string;
		projectId?: string | null;
	}): Promise<ImportAgentResult> {
		if (!input.source) {
			return { status: "invalid", message: "source (markdown) is required" };
		}

		let parsed: ReturnType<typeof parseAgentMarkdown>;
		try {
			parsed = parseAgentMarkdown(input.source);
		} catch (err) {
			return {
				status: "invalid",
				message: err instanceof Error ? err.message : "Failed to parse markdown",
			};
		}

		const warnings: string[] = [];
		const environment = await this.resolveEnvironment(parsed.environmentRef, warnings);
		const vaultIds = await this.resolveVaultIds(parsed.vaultRefs, warnings);

		const result = await this.deps.agents.createAgent({
			name: parsed.name,
			description: parsed.description ?? null,
			config: parsed.config,
			runtime: parsed.runtime ?? "dapr-agent-py",
			environmentId: environment?.id ?? null,
			environmentVersion: environment?.currentVersion ?? null,
			defaultVaultIds: vaultIds,
			createdBy: input.userId,
			projectId: input.projectId ?? null,
		});
		if (!result.ok) return { status: "invalid", message: result.message };
		return { status: "created", agent: result.agent, warnings };
	}

	async exportAgent(input: { agentId: string }): Promise<ExportAgentResult> {
		const agent = await this.deps.agents.getAgent(input.agentId);
		if (!agent) return { status: "not_found", message: "Agent not found" };

		const environmentSlug = agent.environmentId
			? (await this.deps.references.resolveEnvironmentSlug({
					id: agent.environmentId,
					version: agent.environmentVersion ?? null,
				})) ?? agent.environmentId
			: undefined;
		const markdown = serializeAgentMarkdown({
			name: agent.name,
			description: agent.description,
			config: agent.config,
			environmentSlugOrId: environmentSlug,
			vaultIds: agent.defaultVaultIds,
		});
		return {
			status: "ok",
			markdown,
			filename: `${agent.slug}.md`,
		};
	}

	private async resolveEnvironment(
		ref: string | undefined,
		warnings: string[],
	): Promise<AgentImportExportEnvironmentRef | null> {
		if (!ref) return null;
		const environments = await this.deps.references.listEnvironments({
			includeArchived: false,
		});
		const match =
			environments.find((environment) => environment.id === ref) ??
			environments.find((environment) => environment.slug === ref);
		if (!match) {
			warnings.push(`environment '${ref}' not found; skipped`);
			return null;
		}
		return match;
	}

	private async resolveVaultIds(
		refs: string[] | undefined,
		warnings: string[],
	): Promise<string[]> {
		if (!refs || refs.length === 0) return [];
		const vaults = await this.deps.references.listVaults({
			includeArchived: false,
		});
		const byId = new Set(vaults.map((vault) => vault.id));
		const byName = new Map(vaults.map((vault) => [vault.name, vault.id]));
		const ids: string[] = [];
		for (const ref of refs) {
			if (byId.has(ref)) {
				ids.push(ref);
			} else if (byName.has(ref)) {
				ids.push(byName.get(ref)!);
			} else {
				warnings.push(`vault '${ref}' not found; skipped`);
			}
		}
		return ids;
	}
}

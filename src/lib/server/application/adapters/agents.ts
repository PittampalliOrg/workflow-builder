import { and, eq } from "drizzle-orm";
import type {
	AgentCatalogCreateInput,
	AgentCatalogRepository,
	AgentCatalogUpdateInput,
	AgentCatalogUpdateResult,
	AgentCatalogWriteResult,
	AgentCompiledCapabilitiesRepository,
	AgentRegistryRepository,
	AgentRuntimeCatalog,
	AgentTemplateCatalog,
	AgentRuntimeSyncPort,
	PeerAgentDispatchContext,
	PeerAgentOwner,
	PeerAgentResolver,
	SessionAgentResolver,
	SessionAgentSlugResolver,
	SessionControlSettingsReferences,
	SessionExperimentAgentStore,
	SessionForkBaseAgent,
	WorkflowEphemeralAgentStore,
	WorkflowAgentReadRepository,
	WorkflowAgentRuntimeIdentity,
	WorkflowPublishedAgentResolutionResult,
} from "$lib/server/application/ports";
import { db as defaultDb } from "$lib/server/db";
import { agents, agentVersions, users } from "$lib/server/db/schema";
import {
	AgentConfigValidationError,
	archiveAgent,
	createAgent,
	duplicateAgent,
	findAgentUsages,
	findAllAgentUsageCounts,
	getAgentBySlug,
	getAgent,
	getVersion,
	listAgents,
	listVersions,
	resolveAgentRef,
	resolveCallableAgents,
	restoreVersion,
	updateAgent,
} from "$lib/server/agents/registry";
import {
	findOrCreateEphemeralAgent,
	findOrCreateExperimentAgent,
} from "$lib/server/agents/ephemeral";
import {
	agentRegistryKey,
	deregisterAgent,
	getRegistryStatus,
	registerAgent,
	syncAgentRuntimeCR,
} from "$lib/server/agents/registry-sync";
import { compileAgentCapabilities } from "$lib/server/agents/compiled-capabilities";
import { resolveEnvironmentRef } from "$lib/server/environments/registry";
import { agentRuntimeDedicatedAppId } from "$lib/server/agents/runtime-routing";
import { listRuntimeIds } from "$lib/server/agents/runtime-registry";
import { BUILTIN_AGENT_PROFILES } from "$lib/server/agent-profiles";
import { findTemplate } from "$lib/server/agent-templates/catalog";
import type { AgentConfig } from "$lib/types/agents";
import { createDefaultAgentConfig } from "$lib/types/agents";

type Database = typeof defaultDb;

function requireDb(database: Database = defaultDb): Database {
	if (!database) throw new Error("Database not configured");
	return database;
}

export class LegacyWorkflowEphemeralAgentStore
	implements WorkflowEphemeralAgentStore
{
	findOrCreateWorkflowEphemeralAgent(
		input: Parameters<
			WorkflowEphemeralAgentStore["findOrCreateWorkflowEphemeralAgent"]
		>[0],
	): Promise<{ agentId: string; agentVersion: number }> {
		return findOrCreateEphemeralAgent(input);
	}
}

export class AgentRuntimeRegistrySyncAdapter implements AgentRuntimeSyncPort {
	syncAgentRuntime(agentId: string): Promise<void> {
		return syncAgentRuntimeCR(agentId);
	}
}

export class LegacyAgentCatalogRepository implements AgentCatalogRepository {
	listAgents(input: Parameters<AgentCatalogRepository["listAgents"]>[0]) {
		return listAgents(input);
	}

	getAgent(id: string) {
		return getAgent(id);
	}

	async createAgent(
		input: AgentCatalogCreateInput,
	): Promise<AgentCatalogWriteResult> {
		try {
			const agent = await createAgent(input);
			return { ok: true, agent };
		} catch (err) {
			if (err instanceof AgentConfigValidationError) {
				return { ok: false, reason: "invalid_config", message: err.message };
			}
			throw err;
		}
	}

	async updateAgent(
		id: string,
		input: AgentCatalogUpdateInput,
	): Promise<AgentCatalogUpdateResult> {
		try {
			const agent = await updateAgent(id, input);
			return agent
				? { ok: true, agent }
				: { ok: false, reason: "not_found" };
		} catch (err) {
			if (err instanceof AgentConfigValidationError) {
				return { ok: false, reason: "invalid_config", message: err.message };
			}
			throw err;
		}
	}

	archiveAgent(id: string): Promise<boolean> {
		return archiveAgent(id);
	}

	duplicateAgent(
		id: string,
		input: Parameters<AgentCatalogRepository["duplicateAgent"]>[1],
	) {
		return duplicateAgent(id, input);
	}

	listVersions(agentId: string) {
		return listVersions(agentId);
	}

	getVersion(agentId: string, version: number) {
		return getVersion(agentId, version);
	}

	restoreVersion(agentId: string, version: number, userId?: string | null) {
		return restoreVersion(agentId, version, userId);
	}

	findAgentUsages(agentId: string) {
		return findAgentUsages(agentId);
	}

	findAllAgentUsageCounts() {
		return findAllAgentUsageCounts();
	}
}

export class LegacyAgentCompiledCapabilitiesRepository
	implements AgentCompiledCapabilitiesRepository
{
	async compileAgentCapabilities(agentId: string) {
		return (await compileAgentCapabilities(agentId)) as Awaited<
			ReturnType<AgentCompiledCapabilitiesRepository["compileAgentCapabilities"]>
		>;
	}
}

export class LegacyAgentRegistryRepository implements AgentRegistryRepository {
	getRegistryStatus(
		agentId: string,
		input: Parameters<AgentRegistryRepository["getRegistryStatus"]>[1],
	) {
		return getRegistryStatus(agentId, input);
	}

	registerAgent(agentId: string) {
		return registerAgent(agentId);
	}

	deregisterAgent(agentId: string) {
		return deregisterAgent(agentId);
	}

	syncAgentRuntime(agentId: string) {
		return syncAgentRuntimeCR(agentId);
	}
}

export class LocalAgentRuntimeCatalog implements AgentRuntimeCatalog {
	listRuntimeIds(): string[] {
		return listRuntimeIds();
	}
}

export class LocalAgentTemplateCatalog implements AgentTemplateCatalog {
	resolveAgentTemplateConfig(slug: string | null): AgentConfig | null {
		if (!slug) return null;
		const quickstartTemplate = findTemplate(slug);
		if (quickstartTemplate) return quickstartTemplate.config;
		const template = BUILTIN_AGENT_PROFILES.find(
			(p) => p.slug === slug || p.id === slug,
		);
		if (!template) return null;
		const defaults = createDefaultAgentConfig();
		return {
			...defaults,
			modelSpec: template.config.modelSpec,
			maxTurns: template.config.maxTurns ?? defaults.maxTurns,
			timeoutMinutes: template.config.timeoutMinutes ?? defaults.timeoutMinutes,
			builtinTools: template.config.builtinTools,
			mcpConnectionMode: template.config.mcpConnectionMode,
			mcpServers: template.config.mcpServers,
			skills: template.config.skills,
			runtimeOverridePolicy: template.config.runtimeOverridePolicy,
		};
	}
}

export class RegistryPeerAgentResolver
	implements
		PeerAgentResolver,
		WorkflowAgentReadRepository,
		SessionExperimentAgentStore,
		SessionAgentResolver,
		SessionAgentSlugResolver
{
	constructor(private readonly database: Database = requireDb()) {}

	async resolveSessionAgentIdBySlug(slug: string): Promise<string | null> {
		const agent = await getAgentBySlug(slug);
		return agent?.id ?? null;
	}

	async resolveSessionAgent(input: {
		agentId: string;
		agentVersion?: number | null;
	}) {
		const resolved = await resolveAgentRef({
			id: input.agentId,
			version: input.agentVersion ?? undefined,
		});
		return resolved
			? {
					id: resolved.id,
					name: resolved.name,
					slug: resolved.slug,
					version: resolved.version,
					projectId: resolved.projectId ?? null,
					config: resolved.config,
					runtime: resolved.runtime,
					runtimeAppId: resolved.runtimeAppId,
					mlflowModelVersion: resolved.mlflowModelVersion,
					mlflowModelName: resolved.mlflowModelName,
					mlflowUri: resolved.mlflowUri,
				}
			: null;
	}

	async resolvePeerAgentOwner(peerAgentId: string): Promise<PeerAgentOwner | null> {
		const [peerRow] = await this.database
			.select({
				createdBy: agents.createdBy,
				projectId: agents.projectId,
			})
			.from(agents)
			.where(eq(agents.id, peerAgentId))
			.limit(1);
		if (!peerRow) return null;
		if (peerRow.createdBy) {
			return { userId: peerRow.createdBy, projectId: peerRow.projectId };
		}
		const [anyUser] = await this.database.select({ id: users.id }).from(users).limit(1);
		return { userId: anyUser?.id ?? null, projectId: peerRow.projectId };
	}

	async resolvePeerAgentDispatchContext(input: {
		agentId: string;
		agentVersion?: number | null;
		environmentId?: string | null;
		environmentVersion?: number | null;
	}): Promise<PeerAgentDispatchContext | null> {
		const resolved = await resolveAgentRef({
			id: input.agentId,
			version: input.agentVersion ?? undefined,
		});
		if (!resolved) return null;
		const environment =
			input.environmentId && input.environmentVersion !== null
				? await resolveEnvironmentRef({
						id: input.environmentId,
						version: input.environmentVersion ?? undefined,
					})
				: input.environmentId
					? await resolveEnvironmentRef({ id: input.environmentId })
					: null;
		const callableSlugs = Array.isArray(resolved.config.callableAgents)
			? resolved.config.callableAgents
			: [];
		const callableAgents =
			resolved.projectId && callableSlugs.length > 0
				? (await resolveCallableAgents(resolved.projectId, callableSlugs)).map((p) => ({
						slug: p.slug,
						agentId: p.agentId,
						version: p.version,
						appId: p.runtime,
						team: resolved.projectId as string,
						registryKey: agentRegistryKey(resolved.projectId as string, p.slug),
					}))
				: [];
		return {
			agentConfig: resolved.config,
			environmentConfig: (environment?.config as Record<string, unknown> | undefined) ?? null,
			callableAgents,
			registryTeam: resolved.projectId ?? null,
		};
	}

	async resolveSessionForkBaseAgent(input: {
		agentId: string;
		agentVersion?: number | null;
	}): Promise<SessionForkBaseAgent | null> {
		const resolved = await resolveAgentRef({
			id: input.agentId,
			version: input.agentVersion ?? undefined,
		});
		return resolved
			? {
					id: resolved.id,
					slug: resolved.slug,
					name: resolved.name,
					config: resolved.config,
				}
			: null;
	}

	findOrCreateSessionExperimentAgent(input: {
		baseAgentId: string;
		baseAgentSlug: string;
		baseAgentName: string;
		agentConfig: AgentConfig;
		userId: string;
		projectId?: string | null;
	}): Promise<{ agentId: string; agentVersion: number }> {
		return findOrCreateExperimentAgent(input);
	}

	async getWorkflowAgentRuntimeIdentity(
		agentId: string,
	): Promise<WorkflowAgentRuntimeIdentity | null> {
		const [row] = await this.database
			.select({ slug: agents.slug, runtimeAppId: agents.runtimeAppId })
			.from(agents)
			.where(eq(agents.id, agentId))
			.limit(1);
		if (!row?.slug) return null;
		return {
			agentId,
			slug: row.slug,
			runtimeAppId: row.runtimeAppId ?? null,
			appId: row.runtimeAppId ?? agentRuntimeDedicatedAppId(row.slug),
		};
	}

	async resolvePublishedWorkflowAgentForEnsure(input: {
		agentId: string | null;
		agentVersion?: number | null;
		projectId?: string | null;
	}): Promise<WorkflowPublishedAgentResolutionResult | null> {
		if (!input.agentId) return null;
		const [agent] = await this.database
			.select()
			.from(agents)
			.where(eq(agents.id, input.agentId))
			.limit(1);
		if (!agent || agent.isArchived) {
			return {
				ok: false,
				status: 400,
				message: `agent ${input.agentId} is not available`,
			};
		}
		if (input.projectId && agent.projectId !== input.projectId) {
			return {
				ok: false,
				status: 403,
				message: `agent ${input.agentId} is not in this project`,
			};
		}

		const requestedVersion = input.agentVersion;
		if (
			Number.isInteger(requestedVersion) &&
			requestedVersion !== null &&
			requestedVersion !== undefined &&
			requestedVersion > 0
		) {
			const [version] = await this.database
				.select()
				.from(agentVersions)
				.where(
					and(
						eq(agentVersions.agentId, agent.id),
						eq(agentVersions.version, requestedVersion),
					),
				)
				.limit(1);
			if (!version) {
				return {
					ok: false,
					status: 400,
					message: `agent ${input.agentId} version ${requestedVersion} is not available`,
				};
			}
			return {
				ok: true,
				agent: {
					agentId: agent.id,
					agentVersion: version.version,
					agentSlug: agent.slug,
					agentAppId: agent.runtimeAppId ?? agentRuntimeDedicatedAppId(agent.slug),
					mlflowUri: version.mlflowUri ?? null,
					mlflowModelName: version.mlflowModelName ?? null,
					mlflowModelVersion: version.mlflowModelVersion ?? null,
				},
			};
		}

		if (!agent.currentVersionId) {
			return {
				ok: false,
				status: 400,
				message: `agent ${input.agentId} has no current version`,
			};
		}
		const [current] = await this.database
			.select()
			.from(agentVersions)
			.where(eq(agentVersions.id, agent.currentVersionId))
			.limit(1);
		if (!current) {
			return {
				ok: false,
				status: 400,
				message: `agent ${input.agentId} current version is not available`,
			};
		}
		return {
			ok: true,
			agent: {
				agentId: agent.id,
				agentVersion: current.version,
				agentSlug: agent.slug,
				agentAppId: agent.runtimeAppId ?? agentRuntimeDedicatedAppId(agent.slug),
				mlflowUri: current.mlflowUri ?? null,
				mlflowModelName: current.mlflowModelName ?? null,
				mlflowModelVersion: current.mlflowModelVersion ?? null,
			},
		};
	}

	async resolveSessionControlSettingsReferences(input: {
		agentId: string;
		agentVersion?: number | null;
		environmentId?: string | null;
		environmentVersion?: number | null;
	}): Promise<SessionControlSettingsReferences> {
		const agent = await resolveAgentRef({
			id: input.agentId,
			version: input.agentVersion ?? undefined,
		});
		const environment = input.environmentId
			? await resolveEnvironmentRef({
					id: input.environmentId,
					version: input.environmentVersion ?? undefined,
				})
			: null;

		return {
			agent: agent
				? {
						id: agent.id,
						slug: agent.slug,
						version: agent.version,
						config: agent.config,
					}
				: null,
			environment: environment
				? {
						id: environment.id,
						slug: environment.slug,
						version: environment.version,
						config: environment.config as Record<string, unknown>,
					}
				: null,
		};
	}
}

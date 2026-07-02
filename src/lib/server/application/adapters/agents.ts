import { eq } from "drizzle-orm";
import type {
	PeerAgentDispatchContext,
	PeerAgentOwner,
	PeerAgentResolver,
} from "$lib/server/application/ports";
import { db as defaultDb } from "$lib/server/db";
import { agents, users } from "$lib/server/db/schema";
import {
	resolveAgentRef,
	resolveCallableAgents,
} from "$lib/server/agents/registry";
import { agentRegistryKey } from "$lib/server/agents/registry-sync";
import { resolveEnvironmentRef } from "$lib/server/environments/registry";

type Database = typeof defaultDb;

function requireDb(database: Database = defaultDb): Database {
	if (!database) throw new Error("Database not configured");
	return database;
}

export class RegistryPeerAgentResolver implements PeerAgentResolver {
	constructor(private readonly database: Database = requireDb()) {}

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
}

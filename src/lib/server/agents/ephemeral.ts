import { desc, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { agents, agentVersions } from "$lib/server/db/schema";
import type { AgentConfig } from "$lib/types/agents";
import { hashAgentConfig } from "./config-hash";
import { validateAgentConfig } from "./registry";

/** Tag applied to ephemeral agents auto-created for workflow `durable/run`
 *  nodes. Filtered out of the agents list by default. */
export const EPHEMERAL_TAG_WORKFLOW = "workflow-ephemeral";

/** Tag applied to ephemeral agents created by the SessionConfigDrawer when a
 *  user starts an interactive session with tweaked config. Same filtering as
 *  workflow-ephemeral but kept distinct so the audit trail can tell them
 *  apart and the UI can surface a "Show experiments" toggle. */
export const EPHEMERAL_TAG_SESSION_EXPERIMENT = "session-experiment";

export const ALL_EPHEMERAL_TAGS = [
	EPHEMERAL_TAG_WORKFLOW,
	EPHEMERAL_TAG_SESSION_EXPERIMENT,
] as const;

/**
 * Find-or-create an agent row keyed by a deterministic slug. If a row with
 * that slug already exists, the most recent version is compared by
 * `configHash` — matching configs reuse the existing version, divergent
 * configs append a new one (existing sessions keep their pinned version).
 *
 * This is the shared kernel used by both the workflow `durable/run` path
 * (`findOrCreateEphemeralAgent`) and the interactive UI experiment path
 * (`findOrCreateExperimentAgent`). They differ only in slug shape, name,
 * description, and tag — everything else is identical.
 */
async function ensureEphemeralAgent(params: {
	slug: string;
	name: string;
	description: string;
	tag: typeof EPHEMERAL_TAG_WORKFLOW | typeof EPHEMERAL_TAG_SESSION_EXPERIMENT;
	agentConfig: AgentConfig;
	userId: string;
	projectId?: string | null;
}): Promise<{ agentId: string; agentVersion: number }> {
	if (!db) throw new Error("Database not configured");
	validateAgentConfig(params.agentConfig);
	const configHash = hashAgentConfig(params.agentConfig);

	const [existing] = await db
		.select()
		.from(agents)
		.where(eq(agents.slug, params.slug))
		.limit(1);

	if (existing) {
		const [currentVersion] = await db
			.select()
			.from(agentVersions)
			.where(eq(agentVersions.agentId, existing.id))
			.orderBy(desc(agentVersions.version))
			.limit(1);

		if (currentVersion && currentVersion.configHash === configHash) {
			return { agentId: existing.id, agentVersion: currentVersion.version };
		}

		const nextVersion = (currentVersion?.version ?? 0) + 1;
		const [bumped] = await db
			.insert(agentVersions)
			.values({
				agentId: existing.id,
				version: nextVersion,
				config: params.agentConfig as unknown as Record<string, unknown>,
				configHash,
				publishedAt: new Date(),
				publishedBy: params.userId,
			})
			.returning();
		await db
			.update(agents)
			.set({ currentVersionId: bumped.id, updatedAt: new Date() })
			.where(eq(agents.id, existing.id));
		return { agentId: existing.id, agentVersion: bumped.version };
	}

	const [created] = await db
		.insert(agents)
		.values({
			slug: params.slug,
			name: params.name,
			description: params.description,
			tags: [params.tag],
			runtime: params.agentConfig.runtime,
			createdBy: params.userId,
			projectId: params.projectId ?? null,
		})
		.returning();

	const [version] = await db
		.insert(agentVersions)
		.values({
			agentId: created.id,
			version: 1,
			config: params.agentConfig as unknown as Record<string, unknown>,
			configHash,
			publishedAt: new Date(),
			publishedBy: params.userId,
		})
		.returning();

	await db
		.update(agents)
		.set({ currentVersionId: version.id, updatedAt: new Date() })
		.where(eq(agents.id, created.id));

	return { agentId: created.id, agentVersion: version.version };
}

/**
 * Find-or-create an ephemeral agent row for a workflow `durable/run` node.
 *
 * The agent is keyed by `(workflowId, nodeId)` via a deterministic slug so
 * repeat workflow runs reuse the same row. When `agentConfig` changes
 * (prompt tweak, new model), a new version is appended; existing sessions
 * keep their pinned version.
 *
 * Tagged `workflow-ephemeral` so the agents list filters them out of the UI
 * by default.
 */
export async function findOrCreateEphemeralAgent(params: {
	workflowId: string;
	nodeId: string;
	agentConfig: AgentConfig;
	userId: string;
}): Promise<{ agentId: string; agentVersion: number }> {
	return ensureEphemeralAgent({
		slug: ephemeralSlug(params.workflowId, params.nodeId),
		name: `Ephemeral agent (${params.nodeId})`,
		description: `Auto-created for workflow node ${params.nodeId}`,
		tag: EPHEMERAL_TAG_WORKFLOW,
		agentConfig: params.agentConfig,
		userId: params.userId,
	});
}

/**
 * Find-or-create an ephemeral agent row for an interactive UI session that
 * tweaked the base agent's published config (the SessionConfigDrawer flow).
 *
 * The slug is keyed by `(baseAgentId, configHash)` so the SAME tweaked config
 * applied to the SAME base agent — even from different sessions — reuses
 * one experiment agent row. Tweaks that diverge get distinct rows.
 *
 * Tagged `session-experiment` so the agents list filters them out by default
 * but the UI can opt-in via `?includeEphemeral=true&ephemeralKind=session-experiment`.
 */
export async function findOrCreateExperimentAgent(params: {
	baseAgentId: string;
	baseAgentSlug: string;
	baseAgentName: string;
	agentConfig: AgentConfig;
	userId: string;
	projectId?: string | null;
}): Promise<{ agentId: string; agentVersion: number }> {
	const configHash = hashAgentConfig(params.agentConfig);
	return ensureEphemeralAgent({
		slug: experimentSlug(params.baseAgentSlug, configHash),
		name: `(experiment) ${params.baseAgentName}`,
		description: `Tweaked config experiment of ${params.baseAgentSlug}`,
		tag: EPHEMERAL_TAG_SESSION_EXPERIMENT,
		agentConfig: params.agentConfig,
		userId: params.userId,
		projectId: params.projectId,
	});
}

function ephemeralSlug(workflowId: string, nodeId: string): string {
	const shortWf = workflowId.slice(0, 12).toLowerCase();
	const shortNode = nodeId
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.slice(0, 24);
	return `wf-${shortWf}-${shortNode}`;
}

function experimentSlug(baseAgentSlug: string, configHash: string): string {
	const shortBase = baseAgentSlug
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.slice(0, 24);
	const shortHash = configHash.slice(0, 10).toLowerCase();
	return `exp-${shortBase}-${shortHash}`;
}

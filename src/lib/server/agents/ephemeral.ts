import { and, desc, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { agents, agentVersions } from "$lib/server/db/schema";
import type { AgentConfig } from "$lib/types/agents";
import { hashAgentConfig } from "./config-hash";
import { validateAgentConfig } from "./registry";

/**
 * Find-or-create an ephemeral agent row for a workflow `durable/run` node.
 *
 * The agent is keyed by `(workflowId, nodeId)` via a deterministic slug so
 * repeat workflow runs reuse the same row. When `agentConfig` changes
 * (prompt tweak, new model), a new version is appended; existing sessions
 * keep their pinned version.
 *
 * Ephemeral agents are tagged `workflow-ephemeral` so the agents list can
 * filter them out of the UI by default.
 */
export async function findOrCreateEphemeralAgent(params: {
	workflowId: string;
	nodeId: string;
	agentConfig: AgentConfig;
	userId: string;
}): Promise<{ agentId: string; agentVersion: number }> {
	if (!db) throw new Error("Database not configured");
	validateAgentConfig(params.agentConfig);
	const slug = ephemeralSlug(params.workflowId, params.nodeId);
	const configHash = hashAgentConfig(params.agentConfig);

	const [existing] = await db
		.select()
		.from(agents)
		.where(eq(agents.slug, slug))
		.limit(1);

	if (existing) {
		// Look up current version; if config hash matches, reuse. Else bump.
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

	// First run for this (workflowId, nodeId): create both rows.
	const name = `Ephemeral agent (${params.nodeId})`;
	const [created] = await db
		.insert(agents)
		.values({
			slug,
			name,
			description: `Auto-created for workflow node ${params.nodeId}`,
			tags: ["workflow-ephemeral"],
			runtime: "dapr-agent-py",
			createdBy: params.userId,
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

function ephemeralSlug(workflowId: string, nodeId: string): string {
	const shortWf = workflowId.slice(0, 12).toLowerCase();
	const shortNode = nodeId
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.slice(0, 24);
	return `wf-${shortWf}-${shortNode}`;
}

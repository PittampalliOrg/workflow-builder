import type { RequestHandler } from "./$types";
import { error, json } from "@sveltejs/kit";

import { listAgentRuntimes } from "$lib/server/kube/client";
import { db } from "$lib/server/db";
import { agents } from "$lib/server/db/schema";
import { eq } from "drizzle-orm";

/**
 * Workspace-scoped list of all AgentRuntime CRs, filtered to agents
 * belonging to the caller's active workspace. Non-admin callers see
 * only their workspace's agents; cluster admins see everything.
 *
 * Used by /admin/agent-runtimes dashboard.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!db) return error(500, "Database not configured");

	const projectId = locals.session.projectId;
	const agentRows = projectId
		? await db
				.select({ slug: agents.slug, id: agents.id, isArchived: agents.isArchived })
				.from(agents)
				.where(eq(agents.projectId, projectId))
		: [];
	const slugSet = new Set(agentRows.filter((r) => !r.isArchived).map((r) => r.slug));

	const crs = await listAgentRuntimes();
	const rows = crs
		.filter((cr) => !projectId || slugSet.has(cr.spec.agentSlug))
		.map((cr) => ({
			name: cr.metadata.name,
			slug: cr.spec.agentSlug,
			appId: cr.spec.appId,
			phase: cr.status?.phase ?? "Unknown",
			replicas: cr.status?.replicas ?? 0,
			readyReplicas: cr.status?.readyReplicas ?? 0,
			lastActiveAt: cr.status?.lastActiveAt ?? null,
			imageTag: cr.spec.environment?.imageTag ?? null,
			mcpServers: (cr.spec.mcpServers ?? []).map((s) => s.name),
			idleTtlSeconds: cr.spec.lifecycle?.idleTtlSeconds ?? 1800,
		}));

	return json({ runtimes: rows });
};

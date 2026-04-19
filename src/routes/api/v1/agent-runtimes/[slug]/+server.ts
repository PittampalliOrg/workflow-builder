import type { RequestHandler } from "./$types";
import { error, json } from "@sveltejs/kit";

import {
	getAgentRuntime,
	agentRuntimeName,
} from "$lib/server/kube/client";
import { db } from "$lib/server/db";
import { agents } from "$lib/server/db/schema";
import { and, eq } from "drizzle-orm";

/**
 * Workspace-scoped AgentRuntime status read. Unlike the
 * /api/internal/agent-runtimes route, this one enforces:
 *  - authenticated session
 *  - the agent slug belongs to the caller's active workspace
 *
 * Called by the AgentRuntimeCard component in the agent detail page.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!db) return error(500, "Database not configured");

	const slug = params.slug!;
	const rows = await db
		.select({ id: agents.id, projectId: agents.projectId, slug: agents.slug })
		.from(agents)
		.where(
			and(
				eq(agents.slug, slug),
				locals.session.projectId
					? eq(agents.projectId, locals.session.projectId)
					: undefined,
			),
		)
		.limit(1);
	if (rows.length === 0) return error(404, `Agent ${slug} not found in workspace`);

	const cr = await getAgentRuntime(slug);
	if (!cr) {
		return json({
			name: agentRuntimeName(slug),
			exists: false,
			phase: "Unknown",
			replicas: 0,
		});
	}
	return json({
		name: cr.metadata.name,
		namespace: cr.metadata.namespace,
		exists: true,
		spec: cr.spec,
		status: cr.status ?? {},
		annotations: cr.metadata.annotations ?? {},
	});
};

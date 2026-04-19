import type { RequestHandler } from "./$types";
import { error, json } from "@sveltejs/kit";

import { sleepAgentRuntime } from "$lib/server/kube/client";
import { db } from "$lib/server/db";
import { agents, projectMembers } from "$lib/server/db/schema";
import { and, eq } from "drizzle-orm";

/**
 * Admin-only: immediate scale-to-zero. Gated by projectMembers.role=ADMIN
 * in the caller's active workspace.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(400, "No active workspace");
	if (!db) return error(500, "Database not configured");

	const slug = params.slug!;
	const agentRows = await db
		.select({ id: agents.id })
		.from(agents)
		.where(
			and(
				eq(agents.slug, slug),
				eq(agents.projectId, locals.session.projectId),
			),
		)
		.limit(1);
	if (agentRows.length === 0) return error(404, `Agent ${slug} not found in workspace`);

	const memberRows = await db
		.select({ role: projectMembers.role })
		.from(projectMembers)
		.where(
			and(
				eq(projectMembers.projectId, locals.session.projectId),
				eq(projectMembers.userId, locals.session.userId),
			),
		)
		.limit(1);
	if (memberRows[0]?.role !== "ADMIN") {
		return error(403, "Admin role required to sleep an agent runtime");
	}

	await sleepAgentRuntime(slug);
	return json({ ok: true });
};

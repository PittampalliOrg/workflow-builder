import type { RequestHandler } from "./$types";
import { error, json } from "@sveltejs/kit";

import { listSandboxWarmPools } from "$lib/server/kube/client";
import { db } from "$lib/server/db";
import { agents } from "$lib/server/db/schema";
import { eq } from "drizzle-orm";

/**
 * Workspace-scoped list of SandboxWarmPools (the Arc 3 replacement for the
 * AgentRuntime CR list), filtered to agents in the caller's active workspace.
 * After Arc 3, only browser/Playwright agents have a per-agent warm pool —
 * non-browser agents now use per-session Sandboxes from sandbox-execution-api
 * and don't appear in this list.
 *
 * Powers the /admin/agent-runtimes dashboard.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!db) return error(500, "Database not configured");

	const projectId = locals.session.projectId;
	const agentRows = projectId
		? await db
				.select({
					slug: agents.slug,
					id: agents.id,
					runtimeAppId: agents.runtimeAppId,
					isArchived: agents.isArchived,
				})
				.from(agents)
				.where(eq(agents.projectId, projectId))
		: [];
	const slugSet = new Set(
		agentRows.filter((r) => !r.isArchived).map((r) => r.slug),
	);

	const pools = await listSandboxWarmPools();
	const rows = pools
		.filter((p) => {
			if (!projectId) return true;
			const slug = p.metadata.labels?.["agents.x-k8s.io/slug"];
			return slug ? slugSet.has(slug) : false;
		})
		.map((p) => {
			const desired = p.spec?.replicas ?? 0;
			const replicas = p.status?.replicas ?? 0;
			const ready = p.status?.readyReplicas ?? 0;
			const phase =
				desired === 0 && replicas === 0
					? "Sleeping"
					: desired > 0 && ready >= desired
						? "Active"
						: desired > 0
							? "Starting"
							: "Unknown";
			return {
				name: p.metadata.name,
				slug: p.metadata.labels?.["agents.x-k8s.io/slug"] ?? null,
				phase,
				desiredReplicas: desired,
				replicas,
				readyReplicas: ready,
				sandboxTemplateRef: p.spec.sandboxTemplateRef.name,
			};
		});

	return json({ runtimes: rows });
};

import type { RequestHandler } from "./$types";
import { error, json } from "@sveltejs/kit";

import {
	getAgentRuntime,
	getAgentRuntimePod,
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
			browserSidecarEnabled: false,
			liveBrowserAvailable: false,
		});
	}
	// Derived flags for the UI: browserSidecarEnabled drives whether the
	// Browser state tab is offered at all; browserMcpAvailable says whether
	// it can actually connect right now (phase Active + chromium + mcp ready).
	const browserSidecarEnabled = cr.spec?.browserSidecar?.enabled === true;

	// Live container readiness (Sleeping → empty list). Drives the
	// per-container badges in AgentRuntimeCard and is cheap since we're
	// already hitting the K8s API for the CR.
	let podContainers: Array<{ name: string; ready: boolean }> = [];
	let podName: string | null = null;
	if (cr.status?.phase === "Active") {
		const pod = await getAgentRuntimePod(slug);
		if (pod) {
			podContainers = pod.containers;
			podName = pod.name;
		}
	}
	const chromiumReady = podContainers.some((c) => c.name === "chromium" && c.ready);
	const mcpReady = podContainers.some((c) => c.name === "playwright-mcp" && c.ready);
	const browserMcpAvailable = browserSidecarEnabled && chromiumReady && mcpReady;

	return json({
		name: cr.metadata.name,
		namespace: cr.metadata.namespace,
		exists: true,
		spec: cr.spec,
		status: cr.status ?? {},
		annotations: cr.metadata.annotations ?? {},
		browserSidecarEnabled,
		browserMcpAvailable,
		pod: podName ? { name: podName, containers: podContainers } : null,
	});
};

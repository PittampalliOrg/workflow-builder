import type { RequestHandler } from "./$types";
import { error, json } from "@sveltejs/kit";

import {
	browserAgentSandboxWarmPoolName,
	getAgentRuntimePod,
	getSandboxWarmPool,
} from "$lib/server/kube/client";
import { db } from "$lib/server/db";
import { agents } from "$lib/server/db/schema";
import { and, eq } from "drizzle-orm";
import {
	agentRuntimeDedicatedAppId,
	agentRuntimeSlugFromAppId,
} from "$lib/server/agents/runtime-routing";

/**
 * Workspace-scoped read-through of an agent's SandboxWarmPool status. After
 * Arc 3, browser/Playwright agents have a SandboxWarmPool emitted by
 * registry-sync; non-browser agents have no per-agent K8s state and return
 * `exists: false`.
 *
 * Powers the AgentRuntimeCard component on the agent detail page. The shape
 * is intentionally thin (phase, replica counts, browserSidecarEnabled flag,
 * live container readiness) — same fields the UI consumed pre-Arc-3.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!db) return error(500, "Database not configured");

	const slug = params.slug!;
	const rows = await db
		.select({
			id: agents.id,
			projectId: agents.projectId,
			slug: agents.slug,
			runtimeAppId: agents.runtimeAppId,
		})
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

	const runtimeAppId = rows[0].runtimeAppId ?? agentRuntimeDedicatedAppId(slug);
	const runtimeSlug = agentRuntimeSlugFromAppId(runtimeAppId) ?? slug;
	const poolName = browserAgentSandboxWarmPoolName(runtimeSlug);
	const pool = await getSandboxWarmPool(poolName);
	if (!pool) {
		return json({
			name: poolName,
			exists: false,
			phase: "Unknown",
			replicas: 0,
			readyReplicas: 0,
			browserSidecarEnabled: false,
			browserMcpAvailable: false,
		});
	}

	const desired = pool.spec?.replicas ?? 0;
	const replicas = pool.status?.replicas ?? 0;
	const ready = pool.status?.readyReplicas ?? 0;
	const phase =
		desired === 0 && replicas === 0
			? "Sleeping"
			: desired > 0 && ready >= desired
				? "Active"
				: desired > 0
					? "Starting"
					: "Unknown";

	// `browserSidecarEnabled` was a boolean on the AgentRuntime CR; with the
	// SandboxTemplate pod-shape we infer it from live pod containers. When
	// the pool is Sleeping we leave it false rather than guessing from the
	// template name — UI consumers gate the Browser tab on this flag and we
	// don't want to render an unreachable panel.
	let podContainers: Array<{ name: string; ready: boolean }> = [];
	let podName: string | null = null;
	if (phase === "Active") {
		const pod = await getAgentRuntimePod(runtimeSlug);
		if (pod) {
			podContainers = pod.containers;
			podName = pod.name;
		}
	}
	const chromiumReady = podContainers.some(
		(c) => c.name === "chromium" && c.ready,
	);
	const mcpReady = podContainers.some(
		(c) => c.name === "playwright-mcp" && c.ready,
	);
	const browserSidecarEnabled = podContainers.some(
		(c) => c.name === "playwright-mcp",
	);
	const browserMcpAvailable = browserSidecarEnabled && chromiumReady && mcpReady;

	return json({
		name: pool.metadata.name,
		namespace: pool.metadata.namespace,
		exists: true,
		phase,
		desiredReplicas: desired,
		replicas,
		readyReplicas: ready,
		sandboxTemplateRef: pool.spec.sandboxTemplateRef.name,
		annotations: pool.metadata.annotations ?? {},
		browserSidecarEnabled,
		browserMcpAvailable,
		pod: podName ? { name: podName, containers: podContainers } : null,
	});
};

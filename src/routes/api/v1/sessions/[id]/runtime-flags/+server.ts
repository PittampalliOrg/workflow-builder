import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';

import { db } from '$lib/server/db';
import { agents, sessions } from '$lib/server/db/schema';
import { getAgentRuntime, getAgentRuntimePod } from '$lib/server/kube/client';

// Must stay in sync with ALLOWED_CONTAINERS in ws-kube-exec-proxy.ts and
// the matching set in server-prod.js. Don't offer a container in the UI
// that the shell proxy will 400 on — offering daprd would be surprising
// (it's the Dapr sidecar, not user-authored code).
const SHELLABLE_CONTAINERS = new Set(['chromium', 'playwright-mcp', 'dapr-agent-py']);

/**
 * Compact runtime-flags read for the session detail page. Tells the UI
 *  - whether the agent has a browser sidecar at all (gates the Browser
 *    state panel),
 *  - whether the Browser state panel can render right now (pod Active +
 *    chromium + playwright-mcp ready),
 *  - whether the Shell tab is available (pod Active — shell works for
 *    any runtime pod, not just browser ones), and
 *  - which container names the shell dropdown should offer.
 *
 * Polled every 10s by the session page — cheap enough to not warrant
 * caching. Workspace-scoped via locals.session.projectId.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	if (!db) return error(500, 'Database not configured');

	const sessionId = params.id!;
	const rows = await db
		.select({ slug: agents.slug })
		.from(sessions)
		.innerJoin(agents, eq(agents.id, sessions.agentId))
		.where(
			and(
				eq(sessions.id, sessionId),
				locals.session.projectId
					? eq(agents.projectId, locals.session.projectId)
					: undefined,
			),
		)
		.limit(1);
	if (rows.length === 0) return error(404, 'Session not found in workspace');

	const slug = rows[0].slug;
	const cr = await getAgentRuntime(slug);
	const browserSidecarEnabled = cr?.spec?.browserSidecar?.enabled === true;
	const phase = cr?.status?.phase ?? 'Unknown';

	// Discover the live pod (if any) so the shell dropdown knows which
	// containers to offer. When the CR is Sleeping the pod won't exist
	// and containers will be empty — the UI hides the tab.
	let shellContainers: string[] = [];
	let browserMcpAvailable = false;
	if (phase === 'Active') {
		const pod = await getAgentRuntimePod(slug);
		if (pod) {
			// Filter to the shell-proxy allow-list so the dropdown never offers
			// a container the backend will reject (e.g., daprd).
			shellContainers = pod.containers
				.filter((c) => c.ready && SHELLABLE_CONTAINERS.has(c.name))
				.map((c) => c.name);
			// MCP panel needs the chromium + playwright-mcp sidecar pair
			// both ready so the per-agent Service backend is live.
			if (browserSidecarEnabled) {
				const chromiumReady = pod.containers.some((c) => c.name === 'chromium' && c.ready);
				const mcpReady = pod.containers.some((c) => c.name === 'playwright-mcp' && c.ready);
				browserMcpAvailable = chromiumReady && mcpReady;
			}
		}
	}
	const shellAvailable = phase === 'Active' && shellContainers.length > 0;

	return json({
		agentSlug: slug,
		browserSidecarEnabled,
		browserMcpAvailable,
		shellAvailable,
		shellContainers,
		phase,
	});
};

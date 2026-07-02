import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';

import { getSessionRuntimePod } from '$lib/server/kube/client';
import { getApplicationAdapters } from '$lib/server/application';
import { shellableContainers } from '$lib/server/agents/runtime-registry';

// Runtime-registry-derived (every runtime's main container + browser sidecars).
const ALLOWED_CONTAINERS = shellableContainers();

/**
 * Preflight for the prod shell WS proxy (src/server-prod.js). Validates
 * the user's cookie + workspace scope + container allow-list, then
 * returns the live pod's name/namespace so server-prod.js can open a
 * raw Kubernetes pods/exec WebSocket.
 *
 * Dev mode goes through ws-kube-exec-proxy.ts directly (ssrLoadModule
 * in vite.config.ts) so this endpoint exists only to keep the prod
 * wrapper thin.
 */
export const POST: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');

	const container = url.searchParams.get('container') ?? 'chromium';
	if (!ALLOWED_CONTAINERS.has(container)) return error(400, 'Invalid container');

	const sessionId = params.id!;
	const target = await getApplicationAdapters().workflowData.getSessionRuntimeDebugTarget({
		sessionId,
		projectId: locals.session.projectId ?? null,
		userId: locals.session.userId,
	});
	if (!target) return error(404, 'Session not found in workspace');

	const pod = await getSessionRuntimePod({
		runtimeAppId: target.appId,
		agentSlug: target.agentSlug,
	});
	if (!pod) return error(503, 'Agent pod not running');
	if (!pod.containers.some((c) => c.name === container && c.ready)) {
		return error(503, `${container} container not ready`);
	}

	return json({ pod: pod.name, namespace: pod.namespace, container });
};

import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';

import { getAgentWorkflowHostPod } from '$lib/server/kube/client';
import { getApplicationAdapters } from '$lib/server/application';
import { getRuntimeDescriptor } from '$lib/server/agents/runtime-registry';

/**
 * Preflight for the CLI-terminal WS proxy (server-prod.js +
 * ws-cli-terminal-proxy.ts). Validates the user's cookie/JWT + workspace
 * scope, gates on the session runtime's `interactiveTerminal` capability,
 * and returns the live per-session pod's IP + the cli-agent-py host port so
 * the proxy can open `ws://{podIp}:8002/terminal/{terminalId}` with the
 * INTERNAL_API_TOKEN header. Token-less response by design — the internal
 * token is attached server-side by the proxy, never sent to the browser.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');

	const sessionId = params.id!;
	const target = await getApplicationAdapters().workflowData.getSessionRuntimeDebugTarget({
		sessionId,
		projectId: locals.session.projectId ?? null,
		userId: locals.session.userId,
	});
	if (!target) return error(404, 'Session not found in workspace');

	const descriptor = getRuntimeDescriptor(target.agentRuntime);
	if (descriptor?.capabilities?.interactiveTerminal !== true) {
		return error(409, 'Session runtime does not expose an interactive terminal');
	}

	const pod = await getAgentWorkflowHostPod(target.appId);
	if (!pod?.podIP) return error(503, 'Agent pod not running');

	return json({ podIp: pod.podIP, port: 8002 });
};

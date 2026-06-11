import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';

import {
	browserAgentSandboxWarmPoolName,
	getSessionRuntimePod,
	getSandboxWarmPool,
} from '$lib/server/kube/client';
import { resolveSessionRuntimeDebugTarget } from '$lib/server/sessions/runtime-target';
import {
	getRuntimeDescriptor,
	shellableContainers,
} from '$lib/server/agents/runtime-registry';

// Shell-able containers = every registered runtime's main container + the fixed
// browser sidecars, derived from the runtime registry (single source of truth;
// previously hand-synced here, in ws-kube-exec-proxy.ts, and shell/resolve).
// daprd is excluded by construction — it is the Dapr sidecar, not user code.
const SHELLABLE_CONTAINERS = shellableContainers();

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

	const sessionId = params.id!;
	const target = await resolveSessionRuntimeDebugTarget(
		sessionId,
		locals.session.projectId,
	);
	if (!target) return error(404, 'Session not found in workspace');

	const pool = target.agentSlug
		? await getSandboxWarmPool(browserAgentSandboxWarmPoolName(target.agentSlug))
		: null;
	const desired = pool?.spec?.replicas ?? 0;
	const replicas = pool?.status?.replicas ?? 0;
	const ready = pool?.status?.readyReplicas ?? 0;
	let phase = !pool
		? 'Unknown'
		: desired === 0 && replicas === 0
			? 'Sleeping'
			: desired > 0 && ready >= desired
				? 'Active'
				: desired > 0
					? 'Starting'
					: 'Unknown';

	// Discover the live pod (if any) so the shell dropdown knows which
	// containers to offer. When the pool is Sleeping the pod won't exist
	// and containers will be empty — the UI hides the tab. The presence of
	// a `playwright-mcp` container in the live pod is the source of truth
	// for browserSidecarEnabled (replaces the old CR boolean flag).
	let shellContainers: string[] = [];
	let browserSidecarEnabled = false;
	let browserMcpAvailable = false;
	const livePod = await getSessionRuntimePod({
		runtimeAppId: target.appId,
		agentSlug: target.agentSlug,
	});
	if (livePod) {
		if (!pool) phase = 'Active';
		shellContainers = livePod.containers
			.filter((c) => c.ready && SHELLABLE_CONTAINERS.has(c.name))
			.map((c) => c.name);
		browserSidecarEnabled = livePod.containers.some(
			(c) => c.name === 'playwright-mcp',
		);
		if (browserSidecarEnabled) {
			const chromiumReady = livePod.containers.some(
				(c) => c.name === 'chromium' && c.ready,
			);
			const mcpReady = livePod.containers.some(
				(c) => c.name === 'playwright-mcp' && c.ready,
			);
			browserMcpAvailable = chromiumReady && mcpReady;
		}
	}
	const shellAvailable = phase === 'Active' && shellContainers.length > 0;

	// Interactive-CLI runtimes (registry family interactive-cli) render a
	// terminal-first session page; the Terminal tab proxies straight to the
	// pod's PTY WebSocket on port 8002.
	const descriptor = getRuntimeDescriptor(target.agentRuntime);
	const interactiveTerminal =
		descriptor?.capabilities?.interactiveTerminal === true;
	// Human label for the pinned terminal tab (e.g. "Codex CLI"). One image
	// hosts claude/codex/agy, so the tab name must come from the runtime.
	const cliLabel = interactiveTerminal
		? descriptor?.agentMetadataFramework ?? 'Agent CLI'
		: null;

	return json({
		agentSlug: target.agentSlug,
		runtimeAppId: target.appId,
		runtimeSandboxName: target.runtimeSandboxName,
		browserSidecarEnabled,
		browserMcpAvailable,
		shellAvailable,
		shellContainers,
		interactiveTerminal,
		cliLabel,
		phase,
	});
};

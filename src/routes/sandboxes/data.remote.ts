import { query } from '$app/server';
import { openshellRuntimeFetch } from '$lib/server/openshell-runtime';
import { normalizeSandboxResponse } from '$lib/utils/sandbox-parse';
import { listAgentRuntimeSandboxes } from '$lib/server/agent-runtime-sandboxes';
import { attachSandboxSessions } from '$lib/server/sandbox-sessions';
import type { Sandbox } from '$lib/types/sandbox';

export const getSandboxes = query(async (): Promise<Sandbox[]> => {
	const [openshellResult, runtimeResult] = await Promise.allSettled([
		openshellRuntimeFetch('/api/v1/sandboxes'),
		listAgentRuntimeSandboxes()
	]);
	const openshellSandboxes =
		openshellResult.status === 'fulfilled' && openshellResult.value.ok
			? normalizeSandboxResponse(await openshellResult.value.json())
			: [];
	const runtimeSandboxes =
		runtimeResult.status === 'fulfilled' ? runtimeResult.value : [];
	return attachSandboxSessions([...openshellSandboxes, ...runtimeSandboxes]);
});

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { openshellRuntimeFetch } from '$lib/server/openshell-runtime';
import { normalizeSandboxResponse } from '$lib/utils/sandbox-parse';
import { listAgentRuntimeSandboxes } from '$lib/server/agent-runtime-sandboxes';

export const GET: RequestHandler = async () => {
	const [openshellResult, runtimeSandboxes] = await Promise.allSettled([
		openshellRuntimeFetch('/api/v1/sandboxes'),
		listAgentRuntimeSandboxes()
	]);

	const sandboxes =
		openshellResult.status === 'fulfilled' && openshellResult.value.ok
			? normalizeSandboxResponse(await openshellResult.value.json())
			: [];

	if (openshellResult.status === 'fulfilled' && !openshellResult.value.ok && runtimeSandboxes.status !== 'fulfilled') {
		return error(502, 'Failed to fetch sandboxes');
	}

	return json([
		...sandboxes,
		...(runtimeSandboxes.status === 'fulfilled' ? runtimeSandboxes.value : [])
	]);
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const response = await openshellRuntimeFetch('/api/v1/sandboxes', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
	const data = await response.json();
	return json(data, { status: response.status });
};

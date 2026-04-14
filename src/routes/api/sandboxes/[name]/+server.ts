import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { openshellRuntimeFetch } from '$lib/server/openshell-runtime';
import {
	getAgentRuntimeSandbox,
	isAgentRuntimeSandboxName
} from '$lib/server/agent-runtime-sandboxes';

export const GET: RequestHandler = async ({ params }) => {
	const runtimeSandbox = await getAgentRuntimeSandbox(params.name);
	if (runtimeSandbox) {
		return json({ ok: true, ...runtimeSandbox });
	}

	const response = await openshellRuntimeFetch(
		`/api/v1/sandboxes/${encodeURIComponent(params.name)}`
	);
	if (!response.ok) {
		return error(response.status === 404 ? 404 : 502, 'Sandbox not found');
	}
	return json(await response.json());
};

export const DELETE: RequestHandler = async ({ params }) => {
	if (isAgentRuntimeSandboxName(params.name)) {
		return json(
			{
				ok: false,
				error: 'agent_runtime_delete_not_supported',
				message: 'Agent runtime sandboxes are managed by Kubernetes deployment configuration.'
			},
			{ status: 409 }
		);
	}

	const response = await openshellRuntimeFetch(
		`/api/v1/sandboxes/${encodeURIComponent(params.name)}`,
		{ method: 'DELETE' }
	);
	return json(await response.json(), { status: response.status });
};

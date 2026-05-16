import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { openshellRuntimeFetch } from '$lib/server/openshell-runtime';
import {
	getAgentRuntimeSandbox,
	isAgentRuntimeSandboxName
} from '$lib/server/agent-runtime-sandboxes';
import {
	deleteKubernetesSandbox,
	getKubernetesSandbox,
	type AgentSandboxResource
} from '$lib/server/kube/client';
import type { Sandbox, SandboxPhase } from '$lib/types/sandbox';

function kubeSandboxPhase(resource: AgentSandboxResource): SandboxPhase {
	const phase = String(resource.status?.phase ?? '').toUpperCase();
	if (phase === 'READY' || phase === 'RUNNING') return 'READY';
	if (phase === 'FAILED' || phase === 'ERROR') return 'ERROR';
	if (phase === 'DELETING' || resource.metadata?.deletionTimestamp) {
		return 'DELETING';
	}
	if (phase === 'PENDING' || phase === 'PROVISIONING' || phase === 'CREATING') {
		return 'PROVISIONING';
	}
	return 'UNKNOWN';
}

function kubeSandboxToDto(resource: AgentSandboxResource, name: string): Sandbox {
	return {
		name: resource.metadata?.name ?? name,
		type: 'k8s-crd',
		phase: kubeSandboxPhase(resource),
		provider: resource.metadata?.labels?.['agent-app-id'],
		createdAt: resource.metadata?.creationTimestamp,
		conditions: (resource.status?.conditions ?? []).map((condition) => ({
			type: condition.type ?? 'Unknown',
			status: condition.status ?? 'Unknown',
			message: condition.message
		}))
	};
}

export const GET: RequestHandler = async ({ params }) => {
	const runtimeSandbox = await getAgentRuntimeSandbox(params.name);
	if (runtimeSandbox) {
		return json({ ok: true, ...runtimeSandbox });
	}

	const kubernetesSandbox = await getKubernetesSandbox(params.name).catch(() => null);
	if (kubernetesSandbox) {
		return json({
			ok: true,
			...kubeSandboxToDto(kubernetesSandbox, params.name)
		});
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

	const kubernetesDelete = await deleteKubernetesSandbox(params.name).catch((err) => {
		console.warn(
			`[sandboxes] failed to delete Kubernetes Sandbox ${params.name}:`,
			err instanceof Error ? err.message : err
		);
		return null;
	});
	if (kubernetesDelete === 'deleted') {
		return json({ ok: true, deleted: true, provider: 'kubernetes' });
	}

	const response = await openshellRuntimeFetch(
		`/api/v1/sandboxes/${encodeURIComponent(params.name)}`,
		{ method: 'DELETE' }
	);
	return json(await response.json(), { status: response.status });
};

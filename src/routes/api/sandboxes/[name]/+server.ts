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
import { getApplicationAdapters } from '$lib/server/application';
import { isResourceInScope } from '$lib/server/workflows/project-scope';
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

export const DELETE: RequestHandler = async ({ params, locals }) => {
	// Authenticated only — this reaps a Kubernetes Sandbox CR (a real, irreversible
	// pod teardown). authHandle only POPULATES locals.session; it never rejects, so
	// without this check the route was reachable unauthenticated.
	if (!locals.session?.userId) return error(401, 'Authentication required');

	// Refuse while the named sandbox backs a LIVE session: deleting its CR out-of-band
	// yanks the pod from under the running session_workflow (the DB↔Dapr divergence the
	// lifecycle SSOT prevents). Stop the run first (POST /api/v1/sessions/[id]/stop
	// {mode:'purge'}), which reaps the CR as its final step. Mirrors the per-session
	// route /api/v1/sessions/[id]/sandbox.
	const guard = await getApplicationAdapters().sandboxActiveGuard.activeSessionForSandboxName(
		params.name
	);
	if (guard.active) {
		if (guard.scope && !isResourceInScope(guard.scope, locals.session)) {
			return error(404, 'Sandbox not found');
		}
		return error(
			409,
			"Stop the run before destroying its sandbox (POST /api/v1/sessions/[id]/stop {mode:'purge'})"
		);
	}

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

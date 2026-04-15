import { env } from '$env/dynamic/private';
import type { Sandbox } from '$lib/types/sandbox';

type RuntimeProfile = {
	name: string;
	appId: string;
	namespace: string;
	serviceName: string;
	serviceUrl: string;
	stateStore: string;
	description: string;
	tools: string[];
};

const DEFAULT_RUNTIME_PROFILES: RuntimeProfile[] = [
	{
		name: 'dapr-agent-py',
		appId: 'dapr-agent-py',
		namespace: 'workflow-builder',
		serviceName: 'dapr-agent-py',
		serviceUrl: 'http://dapr-agent-py.workflow-builder.svc.cluster.local:8002',
		stateStore: 'dapr-agent-py-statestore',
		description: 'Default sandbox-hosted dapr-agent-py runtime',
		tools: ['filesystem', 'shell', 'mcp']
	},
	{
		name: 'dapr-agent-py-testing',
		appId: 'dapr-agent-py-testing',
		namespace: 'workflow-builder',
		serviceName: 'dapr-agent-py-testing',
		serviceUrl: 'http://dapr-agent-py-testing.workflow-builder.svc.cluster.local:8002',
		stateStore: 'dapr-agent-py-testing-statestore',
		description: 'Browser MCP testing runtime with Playwright and Chrome DevTools tools',
		tools: ['filesystem', 'shell', 'mcp', 'playwright', 'chrome-devtools']
	}
];

function configuredProfiles(): RuntimeProfile[] {
	if (!env.AGENT_RUNTIME_SANDBOXES_JSON) return DEFAULT_RUNTIME_PROFILES;
	try {
		const parsed = JSON.parse(env.AGENT_RUNTIME_SANDBOXES_JSON);
		if (Array.isArray(parsed)) {
			return parsed
				.map((entry) => ({
					name: String(entry.name ?? ''),
					appId: String(entry.appId ?? entry.name ?? ''),
					namespace: String(entry.namespace ?? 'workflow-builder'),
					serviceName: String(entry.serviceName ?? entry.name ?? ''),
					serviceUrl: String(entry.serviceUrl ?? ''),
					stateStore: String(entry.stateStore ?? ''),
					description: String(entry.description ?? ''),
					tools: Array.isArray(entry.tools) ? entry.tools.map(String) : []
				}))
				.filter((entry) => entry.name && entry.appId && entry.serviceName && entry.serviceUrl);
		}
	} catch {
		// fall back to defaults
	}
	return DEFAULT_RUNTIME_PROFILES;
}

async function fetchRuntimeStatus(profile: RuntimeProfile): Promise<{
	phase: Sandbox['phase'];
	ready: boolean;
	health: Record<string, unknown> | null;
}> {
	try {
		const res = await fetch(`${profile.serviceUrl.replace(/\/$/, '')}/readyz`, {
			signal: AbortSignal.timeout(2000)
		});
		const health = (await res.json().catch(() => null)) as Record<string, unknown> | null;
		return {
			phase: res.ok ? 'READY' : 'ERROR',
			ready: res.ok,
			health
		};
	} catch {
		return {
			phase: 'ERROR',
			ready: false,
			health: null
		};
	}
}

export function isAgentRuntimeSandboxName(name: string): boolean {
	return configuredProfiles().some((profile) => profile.name === name);
}

export async function listAgentRuntimeSandboxes(): Promise<Sandbox[]> {
	return Promise.all(configuredProfiles().map(agentRuntimeSandbox));
}

export async function getAgentRuntimeSandbox(name: string): Promise<Sandbox | null> {
	const profile = configuredProfiles().find((entry) => entry.name === name);
	return profile ? agentRuntimeSandbox(profile) : null;
}

async function agentRuntimeSandbox(profile: RuntimeProfile): Promise<Sandbox> {
	const status = await fetchRuntimeStatus(profile);
	return {
		name: profile.name,
		type: 'agent-runtime',
		phase: status.phase,
		provider: profile.appId,
		createdAt: undefined,
		conditions: [
			{
				type: 'Ready',
				status: status.ready ? 'True' : 'False',
				message: status.ready ? 'Runtime readiness endpoint is healthy' : 'Runtime readiness endpoint is not reachable'
			}
		],
		runtime: {
			runtimeId: profile.name,
			appId: profile.appId,
			namespace: profile.namespace,
			serviceName: profile.serviceName,
			serviceUrl: profile.serviceUrl,
			stateStore: profile.stateStore,
			description: profile.description,
			tools: profile.tools,
			health: status.health
		}
	};
}

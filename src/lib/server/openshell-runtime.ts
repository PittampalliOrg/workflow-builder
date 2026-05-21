import { env } from '$env/dynamic/private';

export function getOpenShellRuntimeUrl(): string {
	return (
		env.OPENSHELL_AGENT_RUNTIME_API_BASE_URL ||
		'http://openshell-agent-runtime.openshell.svc.cluster.local:8083'
	);
}

export function getOpenShellRuntimeWsUrl(): string {
	return (
		env.OPENSHELL_AGENT_RUNTIME_WS_BASE_URL ||
		env.OPENSHELL_AGENT_RUNTIME_WS_URL ||
		'ws://openshell-agent-runtime.openshell.svc.cluster.local:8084'
	);
}

export function getOpenShellRuntimeInternalToken(): string {
	return (
		env.OPENSHELL_AGENT_RUNTIME_INTERNAL_TOKEN ||
		env.INTERNAL_API_TOKEN ||
		''
	);
}

export async function openshellRuntimeFetch(
	path: string,
	options: RequestInit = {}
): Promise<Response> {
	const baseUrl = getOpenShellRuntimeUrl().replace(/\/$/, '');
	const normalizedPath = path.startsWith('/') ? path : `/${path}`;
	const headers = new Headers(options.headers);
	const token = getOpenShellRuntimeInternalToken();
	if (token && !headers.has('X-Internal-Token')) {
		headers.set('X-Internal-Token', token);
	}
	return fetch(`${baseUrl}${normalizedPath}`, { ...options, headers });
}

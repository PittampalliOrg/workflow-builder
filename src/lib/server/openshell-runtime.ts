import { env } from '$env/dynamic/private';

export function getOpenShellRuntimeUrl(): string {
	return (
		env.OPENSHELL_AGENT_RUNTIME_API_BASE_URL ||
		'http://openshell-agent-runtime.openshell.svc.cluster.local:8083'
	);
}

export async function openshellRuntimeFetch(
	path: string,
	options: RequestInit = {}
): Promise<Response> {
	const baseUrl = getOpenShellRuntimeUrl().replace(/\/$/, '');
	const normalizedPath = path.startsWith('/') ? path : `/${path}`;
	return fetch(`${baseUrl}${normalizedPath}`, options);
}

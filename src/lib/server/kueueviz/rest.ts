/**
 * REST passthrough for the upstream YAML endpoint.
 *
 * Used by the workload/queue detail "Raw YAML" tab. Server-side fetch
 * doesn't trigger CORS, so we just relay path + query → response.
 */

import { env as privEnv } from '$env/dynamic/private';

function backendBaseUrl(): string {
	return (
		privEnv.KUEUEVIZ_BACKEND_URL ??
		process.env.KUEUEVIZ_BACKEND_URL ??
		'http://kueue-kueueviz-backend.kueue-system.svc.cluster.local:8080'
	)
		.trim()
		.replace(/\/+$/, '');
}

const SUPPORTED_RESOURCES = new Set([
	'workload',
	'clusterqueue',
	'localqueue',
	'resourceflavor',
	'cohort',
	'event',
	'node',
	'pod',
]);

export type FetchYamlInput = {
	resourceType: string;
	name: string;
	namespace?: string;
};

export type FetchYamlResult =
	| { ok: true; content: string; format: 'yaml' }
	| { ok: false; status: number; message: string };

export async function fetchKueueVizYaml(input: FetchYamlInput): Promise<FetchYamlResult> {
	if (!SUPPORTED_RESOURCES.has(input.resourceType.toLowerCase())) {
		return {
			ok: false,
			status: 400,
			message: `unsupported resource type "${input.resourceType}"`,
		};
	}
	const url = new URL(
		`${backendBaseUrl()}/api/${encodeURIComponent(input.resourceType)}/${encodeURIComponent(input.name)}`,
	);
	url.searchParams.set('output', 'yaml');
	if (input.namespace) url.searchParams.set('namespace', input.namespace);

	const token = (privEnv.KUEUEVIZ_AUTH_TOKEN ?? process.env.KUEUEVIZ_AUTH_TOKEN ?? '').trim();
	const response = await fetch(url, {
		headers: token ? { Authorization: `Bearer ${token}` } : {},
	});

	if (!response.ok) {
		return {
			ok: false,
			status: response.status,
			message: await response.text().catch(() => `HTTP ${response.status}`),
		};
	}
	const body = (await response.json().catch(() => null)) as
		| {
				name?: string;
				type?: string;
				content?: string;
				format?: string;
		  }
		| null;
	if (!body || typeof body.content !== 'string') {
		return { ok: false, status: 502, message: 'malformed YAML response from kueueviz' };
	}
	return { ok: true, content: body.content, format: 'yaml' };
}

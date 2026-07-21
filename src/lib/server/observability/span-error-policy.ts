import type { ObservabilityTraceSpan } from '$lib/types/observability';

function attributeString(
	attributes: Record<string, unknown> | undefined,
	...keys: string[]
): string | null {
	for (const key of keys) {
		const value = attributes?.[key];
		if (typeof value === 'string' && value.trim()) return value.trim();
		if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	}
	return null;
}

function httpPath(attributes: Record<string, unknown> | undefined): string | null {
	const value = attributeString(attributes, 'url.path', 'http.target', 'url.full', 'http.url');
	if (!value) return null;
	try {
		return new URL(value, 'http://kubernetes.invalid').pathname;
	} catch {
		return value.split('?', 1)[0] || null;
	}
}

/** Kubernetes absence responses that the Workflow Builder client treats as success. */
export function isExpectedKubernetesNotFound(span: ObservabilityTraceSpan): boolean {
	if (span.serviceName !== 'workflow-builder') return false;
	const attributes = span.attributes;
	if (
		attributeString(attributes, 'http.response.status_code', 'http.status_code') !== '404'
	) {
		return false;
	}

	const method = attributeString(attributes, 'http.request.method', 'http.method')?.toUpperCase();
	const path = httpPath(attributes);
	if (!method || !path) return false;

	const sandboxResource =
		/^\/apis\/extensions\.agents\.x-k8s\.io\/v1alpha1\/namespaces\/[^/]+\/(sandboxwarmpools|sandboxtemplates)\/[^/]+\/?$/.exec(
			path
		)?.[1] ?? null;
	if (method === 'GET') return sandboxResource === 'sandboxwarmpools';
	if (method !== 'DELETE') return false;
	if (sandboxResource) return true;

	return /^\/api\/v1\/namespaces\/[^/]+\/services\/agent-runtime-[^/]+-mcp\/?$/.test(path);
}

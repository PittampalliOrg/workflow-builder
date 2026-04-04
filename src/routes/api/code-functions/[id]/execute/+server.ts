import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getCodeFunction } from '$lib/server/code-functions';
import { daprFetch, getFunctionRouterUrl } from '$lib/server/dapr-client';

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) {
		throw error(401, 'Authentication required');
	}
	if (!params.id) {
		throw error(400, 'Code function id is required');
	}

	const detail = await getCodeFunction(params.id, locals.session.userId);
	if (!detail) {
		throw error(404, 'Code function not found');
	}

	let body: Record<string, unknown> = {};
	try {
		body = await request.json();
	} catch {
		// Empty body is fine.
	}

	const input =
		typeof body.input === 'object' && body.input !== null && !Array.isArray(body.input)
			? (body.input as Record<string, unknown>)
			: {};

	const executionId = `code-preview-${detail.id}-${Date.now()}`;
	const routerUrl = getFunctionRouterUrl();

	const response = await daprFetch(`${routerUrl}/execute`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			function_slug: `code/${detail.slug}`,
			execution_id: executionId,
			workflow_id: 'code-function-preview',
			node_id: `code-function-${detail.id}`,
			node_name: detail.name,
			input: {
				functionRef: {
					id: detail.id,
					slug: detail.slug,
					version: detail.version,
				},
				body: {
					input,
					metadata: {
						sourceKind: 'code',
						codeFunctionId: detail.id,
						slug: detail.slug,
						version: detail.version,
						language: detail.language,
						entrypoint: detail.entrypoint,
						path: detail.path,
					},
				},
			},
		}),
	});

	const payload = (await response.json().catch(() => null)) as
		| { success?: boolean; data?: unknown; error?: string; routed_to?: string; duration_ms?: number }
		| null;

	if (!response.ok || !payload) {
		throw error(response.status || 502, payload?.error || `Function router returned HTTP ${response.status}`);
	}

	return json(payload);
};

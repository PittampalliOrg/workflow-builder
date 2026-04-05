import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getActionCatalogDetail } from '$lib/server/action-catalog';
import { getCodeFunction } from '$lib/server/code-functions';
import { daprFetch, getFunctionRouterUrl } from '$lib/server/dapr-client';

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseConnectionExternalIdFromAuthTemplate(value: unknown): string | null {
	if (typeof value !== 'string' || value.trim().length === 0) return null;
	const match = value.match(/connections\['([^']+)'\]/);
	return match?.[1] || null;
}

function mergeInputIntoWithConfig(
	withConfig: Record<string, unknown> | null | undefined,
	input: Record<string, unknown>,
): Record<string, unknown> {
	const base = isRecord(withConfig) ? withConfig : {};
	const body = isRecord(base.body) ? { ...base.body } : {};
	const existingInput = isRecord(body.input) ? body.input : {};

	return {
		...base,
		body: {
			...body,
			input: {
				...existingInput,
				...input,
			},
		},
	};
}

async function executeViaFunctionRouter(args: {
	functionSlug: string;
	input: Record<string, unknown>;
	nodeName: string;
	nodeId: string;
	workflowId: string;
	connectionExternalId?: string | null;
}): Promise<Response> {
	return daprFetch(`${getFunctionRouterUrl()}/execute`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			function_slug: args.functionSlug,
			execution_id: `action-test-${Date.now()}`,
			workflow_id: args.workflowId,
			node_id: args.nodeId,
			node_name: args.nodeName,
			input: args.input,
			...(args.connectionExternalId
				? {
						connection_external_id: args.connectionExternalId,
					}
				: {}),
		}),
		maxRetries: 1,
	});
}

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) {
		throw error(401, 'Authentication required');
	}
	if (!params.actionId) {
		throw error(400, 'Action id is required');
	}

	const actionId = params.actionId;
	const action = await getActionCatalogDetail(actionId, locals.session.userId);
	if (!action) {
		throw error(404, 'Action not found');
	}

	let body: Record<string, unknown> = {};
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		body = {};
	}

	const userInput =
		isRecord(body.input)
			? body.input
			: {};

	if (actionId.startsWith('code-function.')) {
		const codeFunctionId = actionId.slice('code-function.'.length);
		const detail = await getCodeFunction(codeFunctionId, locals.session.userId);
		if (!detail) {
			throw error(404, 'Code function not found');
		}

		const response = await executeViaFunctionRouter({
			functionSlug: `code/${detail.slug}`,
			nodeId: `code-function-${detail.id}`,
			nodeName: detail.name,
			workflowId: 'action-catalog-test',
			input: {
				functionRef: {
					id: detail.id,
					slug: detail.slug,
					version: detail.version,
				},
				body: {
					input: userInput,
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
		});

		const payload = (await response.json().catch(() => null)) as
			| { success?: boolean; data?: unknown; error?: string; duration_ms?: number }
			| null;

		if (!response.ok || !payload) {
			throw error(response.status || 502, payload?.error || `Function router returned HTTP ${response.status}`);
		}

		return json(payload);
	}

	const raw = action.raw && isRecord(action.raw) ? action.raw : {};
	const taskConfig =
		(isRecord(raw.taskConfig) ? raw.taskConfig : null) ??
		(action.sw.taskConfig && isRecord(action.sw.taskConfig) ? action.sw.taskConfig : null) ??
		(isRecord(raw.definition) ? raw.definition : null) ??
		(action.sw.definition && isRecord(action.sw.definition) ? action.sw.definition : null);

	if (!taskConfig) {
		throw error(400, 'Action does not expose an executable taskConfig');
	}

	const call = typeof taskConfig.call === 'string' ? taskConfig.call.trim() : '';
	const withConfig = mergeInputIntoWithConfig(
		isRecord(taskConfig.with) ? taskConfig.with : null,
		userInput,
	);
	const withBody = isRecord(withConfig.body) ? withConfig.body : {};
	const executableInput = isRecord(withBody.input) ? withBody.input : userInput;
	const connectionExternalId = parseConnectionExternalIdFromAuthTemplate(
		executableInput.auth,
	);

	if (!call) {
		throw error(400, 'Action taskConfig is missing call');
	}

	if (!['http', 'grpc', 'openapi', 'asyncapi'].includes(call)) {
		const response = await executeViaFunctionRouter({
			functionSlug: call,
			nodeId: action.id,
			nodeName: action.displayName,
			workflowId: 'action-catalog-test',
			input: executableInput,
			connectionExternalId,
		});

		const payload = (await response.json().catch(() => null)) as
			| { success?: boolean; data?: unknown; error?: string; duration_ms?: number }
			| null;

		if (!response.ok || !payload) {
			throw error(response.status || 502, payload?.error || `Function router returned HTTP ${response.status}`);
		}

		return json(payload);
	}

	if (call !== 'http') {
		throw error(400, `Direct test execution for ${call} actions is not implemented`);
	}

	const endpoint = isRecord(withConfig.endpoint) ? withConfig.endpoint : {};
	const uri = typeof endpoint.uri === 'string' ? endpoint.uri.trim() : '';
	if (!uri) {
		throw error(400, 'HTTP action is missing endpoint.uri');
	}

	const headers = isRecord(withConfig.headers)
		? Object.fromEntries(
				Object.entries(withConfig.headers).filter((entry): entry is [string, string] =>
					typeof entry[0] === 'string' && typeof entry[1] === 'string',
				),
			)
		: {};
	const method = typeof withConfig.method === 'string' ? withConfig.method.toUpperCase() : 'POST';
	const response = await daprFetch(uri, {
		method,
		headers: {
			'content-type': 'application/json',
			...headers,
		},
		body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(withConfig.body ?? {}),
		maxRetries: 1,
	});
	const payload = await response.json().catch(() => null);

	if (!response.ok) {
		throw error(response.status || 502, `HTTP action returned ${response.status}`);
	}

	return json({
		success: true,
		data: payload,
		duration_ms: 0,
	});
};

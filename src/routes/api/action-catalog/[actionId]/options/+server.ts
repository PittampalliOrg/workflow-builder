import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getActionCatalogDetail } from '$lib/server/action-catalog';
import { getCodeFunction } from '$lib/server/code-functions';
import { getDecryptedAppConnection, normalizePieceName } from '$lib/server/app-connections';
import { apPieceServiceUrl } from '$lib/server/activepieces/piece-service';
import { daprFetch } from '$lib/server/dapr-client';

const OPTIONS_PROXY_TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseConnectionExternalId(input: Record<string, unknown>): string | null {
	const authValue = input.auth;
	if (typeof authValue !== 'string') return null;
	const match = authValue.match(/connections\['([^']+)'\]/);
	return match?.[1] || null;
}

type OptionRequestBody = {
	param?: string;
	field?: string;
	input?: Record<string, unknown>;
	connectionExternalId?: string | null;
	searchValue?: string;
	search_value?: string;
};

/**
 * Per-piece piece-runtimes are Knative scale-to-0 Services — the first options
 * request after idle can hit a cold start. Surface fetch failures/timeouts as
 * a 503 "warming" payload so the UI can show a warming-up state and retry.
 */
function warmingResponse(piece: string, err: unknown) {
	const message = err instanceof Error ? err.message : String(err);
	return json(
		{
			warming: true,
			options: [],
			error: `Piece service for "${piece}" is unavailable (possibly cold-starting): ${message}`,
		},
		{ status: 503 },
	);
}

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) {
		throw error(401, 'Authentication required');
	}

	const actionId = params.actionId;
	if (!actionId) {
		throw error(400, 'actionId is required');
	}

	let body: OptionRequestBody = {};
	try {
		body = (await request.json()) as OptionRequestBody;
	} catch {
		body = {};
	}

	const field =
		typeof body.param === 'string' && body.param.trim().length > 0
			? body.param.trim()
			: typeof body.field === 'string' && body.field.trim().length > 0
				? body.field.trim()
				: '';
	if (!field) {
		throw error(400, 'param is required');
	}

	const input = isRecord(body.input) ? { ...body.input } : {};
	const searchValue =
		typeof body.searchValue === 'string'
			? body.searchValue
			: typeof body.search_value === 'string'
				? body.search_value
				: undefined;

	if (actionId.startsWith('code-function.')) {
		const codeFunctionId = actionId.slice('code-function.'.length);
		const detail = await getCodeFunction(codeFunctionId, locals.session.userId);
		if (!detail) {
			throw error(404, 'Code function not found');
		}

		const payload = await fetch(new URL('/api/code-functions/options', request.url), {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				cookie: request.headers.get('cookie') || '',
			},
			body: JSON.stringify({
				functionRef: {
					id: detail.id,
					slug: detail.slug,
					version: detail.version,
				},
				param: field,
				input,
				searchValue,
			}),
		});

		const responsePayload = await payload.json().catch(() => null);
		return json(responsePayload, { status: payload.status });
	}

	const action = await getActionCatalogDetail(actionId, locals.session.userId);
	if (!action) {
		throw error(404, 'Action not found');
	}
	const raw =
		action.raw && isRecord(action.raw) ? action.raw : null;
	if (action.serviceId !== 'activepieces') {
		throw error(400, 'Dynamic options are only implemented for Activepieces and code functions');
	}

	const authMeta = action.auth;
	const connectionExternalId =
		typeof body.connectionExternalId === 'string' && body.connectionExternalId.trim().length > 0
			? body.connectionExternalId.trim()
			: parseConnectionExternalId(input);

	if (authMeta?.required === true && !connectionExternalId) {
		return json({
			options: [],
			disabled: true,
			placeholder: 'Select a connection first',
		});
	}

	let auth: unknown = undefined;
	if (connectionExternalId) {
		const connection = await getDecryptedAppConnection(connectionExternalId);
		if (!connection) {
			throw error(404, 'Connection not found');
		}
		if (
			action.providerId &&
			normalizePieceName(connection.pieceName) !== normalizePieceName(action.providerId)
		) {
			throw error(400, 'Selected connection does not match this provider');
		}
		auth = connection.value;
	}

	delete input.auth;

	const pieceName =
		typeof raw?.pieceName === 'string' && raw.pieceName.trim().length > 0
			? raw.pieceName
			: action.providerId || action.group;
	const actionName =
		typeof raw?.actionName === 'string' && raw.actionName.trim().length > 0
			? raw.actionName
			: action.actionName || action.entrypoint || action.slug;

	let response: Response;
	try {
		response = await daprFetch(`${apPieceServiceUrl(pieceName)}/options`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				pieceName,
				actionName,
				propertyName: field,
				auth,
				input,
				searchValue,
			}),
			maxRetries: 1,
			signal: AbortSignal.timeout(OPTIONS_PROXY_TIMEOUT_MS),
		});
	} catch (err) {
		return warmingResponse(pieceName, err);
	}

	if ([502, 503, 504].includes(response.status)) {
		const text = await response.text().catch(() => '');
		return warmingResponse(pieceName, new Error(text || `HTTP ${response.status}`));
	}

	const payload = await response.json().catch(() => null);
	return json(payload, { status: response.status });
};

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDaprAgentPyUrls } from '$lib/server/dapr-client';

const OPERATIONS = new Set(['login', 'status', 'logout', 'refresh', 'complete']);

async function proxyOAuth(operation: string, method: 'GET' | 'POST', payload?: string) {
	if (!OPERATIONS.has(operation)) throw error(404, 'Unknown OAuth operation');

	let lastError = '';
	for (const baseUrl of getDaprAgentPyUrls('dapr-agent-py')) {
		try {
			const response = await fetch(`${baseUrl.replace(/\/$/, '')}/oauth/${operation}`, {
				method,
				headers: {
					Accept: 'application/json',
					...(payload ? { 'Content-Type': 'application/json' } : {})
				},
				body: payload,
				signal: AbortSignal.timeout(10_000)
			});
			const contentType = response.headers.get('content-type') ?? '';
			const body = contentType.includes('application/json')
				? await response.json().catch(() => ({}))
				: { message: await response.text().catch(() => '') };
			return json(body, { status: response.status });
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
		}
	}

	throw error(502, `dapr-agent-py OAuth endpoint is unavailable: ${lastError || 'unknown error'}`);
}

export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.session?.userId) throw error(401, 'Unauthorized');
	if (params.operation !== 'status') throw error(405, 'Method not allowed');
	return proxyOAuth(params.operation, 'GET');
};

export const POST: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.session?.userId) throw error(401, 'Unauthorized');
	if (!['login', 'logout', 'refresh', 'complete'].includes(params.operation)) {
		throw error(405, 'Method not allowed');
	}
	const body = params.operation === 'complete' ? await request.text() : undefined;
	return proxyOAuth(params.operation, 'POST', body);
};

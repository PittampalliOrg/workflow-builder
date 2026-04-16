import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDaprAgentPyUrls } from '$lib/server/dapr-client';

const OPERATIONS = new Set(['login', 'status', 'logout', 'refresh', 'complete']);
const POST_OPERATIONS = new Set(['login', 'logout', 'refresh', 'complete']);

async function proxyGeminiOAuth(operation: string, method: 'GET' | 'POST', body?: unknown) {
	if (!OPERATIONS.has(operation)) throw error(404, 'Unknown Gemini OAuth operation');

	let lastError = '';
	for (const baseUrl of getDaprAgentPyUrls('dapr-agent-py')) {
		try {
			const response = await fetch(`${baseUrl.replace(/\/$/, '')}/gemini-oauth/${operation}`, {
				method,
				headers: {
					Accept: 'application/json',
					...(body ? { 'Content-Type': 'application/json' } : {})
				},
				body: body ? JSON.stringify(body) : undefined,
				signal: AbortSignal.timeout(20_000)
			});
			const contentType = response.headers.get('content-type') ?? '';
			const payload = contentType.includes('application/json')
				? await response.json().catch(() => ({}))
				: { message: await response.text().catch(() => '') };
			return json(payload, { status: response.status });
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
		}
	}

	throw error(502, `dapr-agent-py Gemini OAuth endpoint is unavailable: ${lastError || 'unknown error'}`);
}

export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.session?.userId) throw error(401, 'Unauthorized');
	if (params.operation !== 'status') throw error(405, 'Method not allowed');
	return proxyGeminiOAuth(params.operation, 'GET');
};

export const POST: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.session?.userId) throw error(401, 'Unauthorized');
	if (!POST_OPERATIONS.has(params.operation)) throw error(405, 'Method not allowed');
	const body = params.operation === 'complete' ? await request.json().catch(() => ({})) : undefined;
	return proxyGeminiOAuth(params.operation, 'POST', body);
};

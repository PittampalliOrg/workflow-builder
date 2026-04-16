import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDaprAgentPyUrls } from '$lib/server/dapr-client';

const OPERATIONS = new Set(['login', 'status', 'logout', 'refresh', 'complete', 'poll']);
const POST_OPERATIONS = new Set(['login', 'logout', 'refresh', 'complete', 'poll']);

async function proxyOpenAIOAuth(operation: string, method: 'GET' | 'POST') {
	if (!OPERATIONS.has(operation)) throw error(404, 'Unknown OpenAI OAuth operation');

	let lastError = '';
	for (const baseUrl of getDaprAgentPyUrls('dapr-agent-py')) {
		try {
			const response = await fetch(`${baseUrl.replace(/\/$/, '')}/openai-oauth/${operation}`, {
				method,
				headers: { Accept: 'application/json' },
				signal: AbortSignal.timeout(20_000)
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

	throw error(502, `dapr-agent-py OpenAI OAuth endpoint is unavailable: ${lastError || 'unknown error'}`);
}

export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.session?.userId) throw error(401, 'Unauthorized');
	if (params.operation !== 'status') throw error(405, 'Method not allowed');
	return proxyOpenAIOAuth(params.operation, 'GET');
};

export const POST: RequestHandler = async ({ locals, params }) => {
	if (!locals.session?.userId) throw error(401, 'Unauthorized');
	if (!POST_OPERATIONS.has(params.operation)) throw error(405, 'Method not allowed');
	return proxyOpenAIOAuth(params.operation, 'POST');
};

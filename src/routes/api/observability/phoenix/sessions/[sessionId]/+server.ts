import { env } from '$env/dynamic/private';
import { redirect, error, type RequestHandler } from '@sveltejs/kit';

function baseUrl() {
	return (env.PHOENIX_BASE_URL || 'https://phoenix-ryzen.tail286401.ts.net').replace(/\/+$/, '');
}

function apiBaseUrl() {
	return (env.PHOENIX_API_BASE_URL || env.PHOENIX_BASE_URL || 'https://phoenix-ryzen.tail286401.ts.net').replace(/\/+$/, '');
}

export const GET: RequestHandler = async (event) => {
	const { params, fetch } = event;
	const sessionIdParam = (params as Record<string, string | undefined>).sessionId;
	const sessionId = typeof sessionIdParam === 'string' ? sessionIdParam.trim() : '';
	if (!sessionId) {
		return error(400, 'Session id is required');
	}

	const headers: Record<string, string> = { Accept: 'application/json' };
	if (env.PHOENIX_API_KEY) {
		headers.Authorization = `Bearer ${env.PHOENIX_API_KEY}`;
	}

	let response: Response;
	try {
		response = await fetch(`${apiBaseUrl()}/v1/sessions/${encodeURIComponent(sessionId)}`, {
			method: 'GET',
			headers
		});
	} catch (err) {
		console.warn(
			`[phoenix] session lookup failed for ${sessionId}:`,
			err instanceof Error ? err.message : err
		);
		return error(502, `Phoenix session lookup failed for ${sessionId}`);
	}

	if (!response.ok) {
		return error(response.status === 404 ? 404 : 502, `Phoenix session lookup failed for ${sessionId}`);
	}

	const payload = await response.json();
	const data = payload?.data as { id?: string; project_id?: string } | undefined;
	if (!data?.id || !data?.project_id) {
		return error(502, 'Phoenix session lookup returned an invalid payload');
	}

	return redirect(302, `${baseUrl()}/projects/${data.project_id}/sessions/${data.id}`);
};

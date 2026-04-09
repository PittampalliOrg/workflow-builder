import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { openshellRuntimeFetch } from '$lib/server/openshell-runtime';
import { normalizeSandboxResponse } from '$lib/utils/sandbox-parse';

export const GET: RequestHandler = async () => {
	const response = await openshellRuntimeFetch('/api/v1/sandboxes');
	if (!response.ok) {
		return error(502, 'Failed to fetch sandboxes');
	}
	const data = await response.json();
	return json(normalizeSandboxResponse(data));
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const response = await openshellRuntimeFetch('/api/v1/sandboxes', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
	const data = await response.json();
	return json(data, { status: response.status });
};

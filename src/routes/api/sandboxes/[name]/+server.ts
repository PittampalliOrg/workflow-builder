import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { openshellRuntimeFetch } from '$lib/server/openshell-runtime';

export const GET: RequestHandler = async ({ params }) => {
	const response = await openshellRuntimeFetch(
		`/api/v1/sandboxes/${encodeURIComponent(params.name)}`
	);
	if (!response.ok) {
		return error(response.status === 404 ? 404 : 502, 'Sandbox not found');
	}
	return json(await response.json());
};

export const DELETE: RequestHandler = async ({ params }) => {
	const response = await openshellRuntimeFetch(
		`/api/v1/sandboxes/${encodeURIComponent(params.name)}`,
		{ method: 'DELETE' }
	);
	return json(await response.json(), { status: response.status });
};

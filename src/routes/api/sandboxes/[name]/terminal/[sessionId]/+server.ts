import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { openshellRuntimeFetch } from '$lib/server/openshell-runtime';

export const DELETE: RequestHandler = async ({ params }) => {
	const response = await openshellRuntimeFetch(
		`/api/v1/sandboxes/${encodeURIComponent(params.name)}/terminal-sessions/${encodeURIComponent(params.sessionId)}`,
		{ method: 'DELETE' }
	);
	return json(await response.json(), { status: response.status });
};

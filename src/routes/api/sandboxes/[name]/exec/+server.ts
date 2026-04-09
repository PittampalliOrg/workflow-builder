import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { openshellRuntimeFetch } from '$lib/server/openshell-runtime';

export const POST: RequestHandler = async ({ params, request, url }) => {
	const body = await request.json();
	const stream = url.searchParams.get('stream') === 'true';

	const upstream = await openshellRuntimeFetch(
		`/api/v1/sandboxes/${encodeURIComponent(params.name)}/exec${stream ? '?stream=true' : ''}`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		}
	);

	if (stream) {
		if (!upstream.ok || !upstream.body) {
			return new Response('upstream unavailable', { status: 502 });
		}
		return new Response(upstream.body, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache, no-transform',
				Connection: 'keep-alive',
				'X-Accel-Buffering': 'no'
			}
		});
	}

	return json(await upstream.json(), { status: upstream.status });
};

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { daprFetch, getFnActivepiecesUrl } from '$lib/server/dapr-client';

export const GET: RequestHandler = async ({ params }) => {
	try {
		const res = await daprFetch(
			`${getFnActivepiecesUrl()}/catalog/functions/${params.name}/${params.version}/function.yaml`,
			{ maxRetries: 1 }
		);
		if (!res.ok) {
			return json({ error: 'Function not found' }, { status: 404 });
		}
		return json(await res.json());
	} catch (err) {
		return json({ error: String(err) }, { status: 502 });
	}
};

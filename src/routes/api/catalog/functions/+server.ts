import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { daprFetch, getFnActivepiecesUrl } from '$lib/server/dapr-client';

let cachedResponse: unknown = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60_000;

export const GET: RequestHandler = async () => {
	if (cachedResponse && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
		return json(cachedResponse);
	}

	try {
		const res = await daprFetch(`${getFnActivepiecesUrl()}/catalog/functions`, { maxRetries: 1 });
		if (!res.ok) {
			return json({ functions: [], count: 0, error: `HTTP ${res.status}` }, { status: res.status });
		}
		const data = await res.json();
		cachedResponse = data;
		cacheTimestamp = Date.now();
		return json(data);
	} catch (err) {
		return json({ functions: [], count: 0, error: String(err) }, { status: 502 });
	}
};

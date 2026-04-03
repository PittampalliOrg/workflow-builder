import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** Dapr sidecar probes this endpoint for pub/sub subscriptions. Return empty array = no subscriptions. */
export const GET: RequestHandler = async () => {
	return json([]);
};

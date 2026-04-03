import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** Dapr sidecar probes this endpoint for app configuration. */
export const GET: RequestHandler = async () => {
	return json({});
};

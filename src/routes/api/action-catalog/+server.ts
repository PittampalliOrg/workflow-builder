import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { loadActionCatalogSnapshot } from '$lib/server/action-catalog';

export const GET: RequestHandler = async ({ locals }) => {
	return json(await loadActionCatalogSnapshot(locals.session?.userId ?? null));
};

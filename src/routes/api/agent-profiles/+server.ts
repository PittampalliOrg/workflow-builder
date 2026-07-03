import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) throw error(401, 'Unauthorized');
	const profiles = await getApplicationAdapters().agentProfiles.listProfiles();
	return json({ profiles });
};

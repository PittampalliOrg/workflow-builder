import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listAgentProfiles } from '$lib/server/agent-profiles';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');
	const profiles = await listAgentProfiles();
	return json({ profiles });
};

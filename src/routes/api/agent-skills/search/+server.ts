import { error, json, type RequestHandler } from '@sveltejs/kit';
import { searchSkills } from '$lib/server/agent-skills';

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');
	const query = url.searchParams.get('q') || '';
	if (!query.trim()) return json({ skills: [] });
	const skills = await searchSkills(query);
	return json({ skills });
};

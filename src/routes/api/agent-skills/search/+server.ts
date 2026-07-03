import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getApplicationAdapters } from '$lib/server/application';

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');
	const query = url.searchParams.get('q') || '';
	if (!query.trim()) return json({ skills: [] });
	try {
		const skills = await getApplicationAdapters().agentSkills.search({ query });
		return json({ skills });
	} catch (err) {
		console.error('Skill search failed', err);
		return json(
			{ skills: [], error: err instanceof Error ? err.message : 'Skill search failed' },
			{ status: 502 }
		);
	}
};

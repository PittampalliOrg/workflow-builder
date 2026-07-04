import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

export const GET: RequestHandler = async ({ request, cookies }) => {
	const session = await getApplicationAdapters().authSession.getSession({
		request,
		cookies,
	});

	if (!session) {
		return error(401, 'Not authenticated');
	}

	return json({ user: session.user });
};

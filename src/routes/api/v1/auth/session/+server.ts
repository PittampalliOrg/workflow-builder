import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession } from '$lib/server/auth';

export const GET: RequestHandler = async ({ request, cookies }) => {
	const session = await getSession(request, cookies);

	if (!session) {
		return error(401, 'Not authenticated');
	}

	return json({ user: session.user });
};

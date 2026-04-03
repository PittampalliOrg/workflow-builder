import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from '$lib/server/auth';

export const POST: RequestHandler = async ({ cookies }) => {
	cookies.delete(ACCESS_TOKEN_COOKIE, { path: '/' });
	cookies.delete(REFRESH_TOKEN_COOKIE, { path: '/' });

	return json({ success: true });
};

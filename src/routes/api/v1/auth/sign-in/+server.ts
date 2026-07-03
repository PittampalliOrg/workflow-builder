import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE, shouldUseSecureCookies } from '$lib/server/auth';
import { signInWithPassword } from '$lib/server/auth/password-sign-in';

export const POST: RequestHandler = async ({ request, cookies }) => {
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const result = await signInWithPassword(body);
	if (!result.ok) return json({ message: result.message }, { status: result.status });

	const secure = shouldUseSecureCookies(request);
	cookies.set(ACCESS_TOKEN_COOKIE, result.accessToken, {
		path: '/',
		httpOnly: true,
		secure,
		sameSite: 'lax',
		maxAge: 60 * 15
	});
	cookies.set(REFRESH_TOKEN_COOKIE, result.refreshToken, {
		path: '/',
		httpOnly: true,
		secure,
		sameSite: 'lax',
		maxAge: 60 * 60 * 24 * 7
	});

	return json({
		user: result.user,
		accessToken: result.accessToken
	});
};

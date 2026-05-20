import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	ACCESS_TOKEN_COOKIE,
	REFRESH_TOKEN_COOKIE,
	refreshTokens,
	shouldUseSecureCookies,
} from '$lib/server/auth';

export const POST: RequestHandler = async ({ request, cookies }) => {
	const refreshCookie = cookies.get(REFRESH_TOKEN_COOKIE);
	if (!refreshCookie) {
		return error(401, 'Refresh token missing');
	}

	const tokens = await refreshTokens(refreshCookie);
	if (!tokens) {
		cookies.delete(ACCESS_TOKEN_COOKIE, { path: '/' });
		cookies.delete(REFRESH_TOKEN_COOKIE, { path: '/' });
		return error(401, 'Refresh token invalid');
	}

	const secure = shouldUseSecureCookies(request);
	cookies.set(ACCESS_TOKEN_COOKIE, tokens.accessToken, {
		path: '/',
		httpOnly: true,
		secure,
		sameSite: 'lax',
		maxAge: 60 * 60,
	});
	cookies.set(REFRESH_TOKEN_COOKIE, tokens.refreshToken, {
		path: '/',
		httpOnly: true,
		secure,
		sameSite: 'lax',
		maxAge: 60 * 60 * 24 * 7,
	});

	return json({ accessToken: tokens.accessToken });
};

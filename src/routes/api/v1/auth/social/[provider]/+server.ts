import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { getAppUrl } from '$lib/server/app-url';

export const GET: RequestHandler = async ({ params, url, request, cookies }) => {
	const { provider } = params;

	if (provider !== 'github' && provider !== 'google') {
		return new Response(`Unknown provider: ${provider}`, { status: 400 });
	}

	const appUrl = await getAppUrl(url, request);
	const redirectUri = `${appUrl}/api/v1/auth/social/${provider}/callback`;

	const state = crypto.randomUUID();
	cookies.set('oauth_state', state, {
		path: '/',
		httpOnly: true,
		secure: true,
		sameSite: 'lax',
		maxAge: 60 * 10
	});

	let authorizationUrl: string;

	if (provider === 'github') {
		const clientId = env.GITHUB_CLIENT_ID;
		if (!clientId) {
			return new Response('GITHUB_CLIENT_ID not configured', { status: 500 });
		}
		authorizationUrl =
			`https://github.com/login/oauth/authorize` +
			`?client_id=${clientId}` +
			`&redirect_uri=${encodeURIComponent(redirectUri)}` +
			`&scope=read:user,user:email` +
			`&state=${state}`;
	} else {
		const clientId = env.GOOGLE_CLIENT_ID;
		if (!clientId) {
			return new Response('GOOGLE_CLIENT_ID not configured', { status: 500 });
		}
		authorizationUrl =
			`https://accounts.google.com/o/oauth2/v2/auth` +
			`?client_id=${clientId}` +
			`&redirect_uri=${encodeURIComponent(redirectUri)}` +
			`&response_type=code` +
			`&scope=${encodeURIComponent('openid email profile')}` +
			`&state=${state}` +
			`&access_type=offline` +
			`&prompt=consent`;
	}

	redirect(302, authorizationUrl);
};

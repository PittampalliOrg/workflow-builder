import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from '$lib/server/auth';
import { signInSocial } from '$lib/server/auth-social';
import { getAppUrl } from '$lib/server/app-url';

/**
 * GET /api/v1/auth/social/[provider]/callback
 *
 * OAuth callback. Validates state, exchanges code for token, fetches profile,
 * creates/finds user, generates JWT, sets session cookies.
 */
export const GET: RequestHandler = async ({ params, url, request, cookies }) => {
	const { provider } = params;
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const storedState = cookies.get('oauth_state');

	if (!state || !storedState || state !== storedState) {
		redirect(302, '/auth/sign-in?error=invalid_state');
	}

	cookies.delete('oauth_state', { path: '/' });

	if (!code) {
		const err =
			url.searchParams.get('error_description') ||
			url.searchParams.get('error') ||
			'no_code';
		redirect(302, `/auth/sign-in?error=${encodeURIComponent(err)}`);
	}

	const appUrl = await getAppUrl(url, request);
	const redirectUri = `${appUrl}/api/v1/auth/social/${provider}/callback`;

	let email: string;
	let name: string | null;
	let image: string | null;

	try {
		if (provider === 'github') {
			({ email, name, image } = await exchangeGitHub(code, redirectUri));
		} else if (provider === 'google') {
			({ email, name, image } = await exchangeGoogle(code, redirectUri));
		} else {
			redirect(302, '/auth/sign-in?error=unknown_provider');
		}
	} catch (err) {
		console.error(`[OAuth] ${provider} exchange failed:`, err);
		redirect(302, '/auth/sign-in?error=exchange_failed');
	}

	// Sign in or create user with the social profile
	let result;
	try {
		result = await signInSocial({
			email,
			name,
			image,
			provider: provider.toUpperCase() as 'GITHUB' | 'GOOGLE'
		});
	} catch (err) {
		console.error(`[OAuth] signInSocial failed:`, err);
		redirect(302, '/auth/sign-in?error=social_auth_failed');
	}

	// Set session cookies on the Svelte domain (outside try/catch so redirect works)
	cookies.set(ACCESS_TOKEN_COOKIE, result.accessToken, {
		path: '/',
		httpOnly: true,
		secure: true,
		sameSite: 'lax',
		maxAge: 60 * 15
	});
	cookies.set(REFRESH_TOKEN_COOKIE, result.refreshToken, {
		path: '/',
		httpOnly: true,
		secure: true,
		sameSite: 'lax',
		maxAge: 60 * 60 * 24 * 7
	});

	redirect(302, '/workflows');
};

async function exchangeGitHub(code: string, redirectUri: string) {
	const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
		body: JSON.stringify({
			client_id: env.GITHUB_CLIENT_ID,
			client_secret: env.GITHUB_CLIENT_SECRET,
			code,
			redirect_uri: redirectUri
		})
	});
	const tokenData = await tokenRes.json();
	if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);

	const userRes = await fetch('https://api.github.com/user', {
		headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/json' }
	});
	const user = await userRes.json();

	let email = user.email;
	if (!email) {
		const emailRes = await fetch('https://api.github.com/user/emails', {
			headers: {
				Authorization: `Bearer ${tokenData.access_token}`,
				Accept: 'application/json'
			}
		});
		const emails = await emailRes.json();
		email =
			emails.find((e: { primary: boolean }) => e.primary)?.email || emails[0]?.email;
	}
	if (!email) throw new Error('No email from GitHub');

	return { email, name: (user.name || user.login) as string, image: user.avatar_url || null };
}

async function exchangeGoogle(code: string, redirectUri: string) {
	const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: env.GOOGLE_CLIENT_ID!,
			client_secret: env.GOOGLE_CLIENT_SECRET!,
			code,
			redirect_uri: redirectUri,
			grant_type: 'authorization_code'
		})
	});
	const tokenData = await tokenRes.json();
	if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);

	const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
		headers: { Authorization: `Bearer ${tokenData.access_token}` }
	});
	const user = await userRes.json();
	if (!user.email) throw new Error('No email from Google');

	return { email: user.email as string, name: (user.name || null) as string | null, image: (user.picture || null) as string | null };
}

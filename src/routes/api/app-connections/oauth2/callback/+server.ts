import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * GET /api/app-connections/oauth2/callback
 *
 * OAuth2 callback handler. Two modes:
 *
 * 1. Popup mode: Returns HTML that posts the auth code to the parent window
 *    via postMessage/BroadcastChannel/localStorage.
 *
 * 2. Same-tab mode: Stores the auth code in a secure httpOnly cookie and
 *    redirects to /connections?oauth2_resume=1 where the server load function
 *    completes the token exchange. This is the reliable SvelteKit approach.
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const oauthError = url.searchParams.get('error');
	const errorDescription = url.searchParams.get('error_description') ?? '';

	let payload: Record<string, string | null>;
	if (oauthError) {
		payload = { error: oauthError, errorDescription, state };
	} else if (code) {
		payload = { code, state };
	} else {
		payload = {
			error: 'missing_code',
			errorDescription: 'No authorization code received',
			state
		};
	}

	// Always store in a server-side cookie for the same-tab fallback.
	// This cookie is read by the connections page's server load function.
	if (state) {
		cookies.set('oauth2_callback', JSON.stringify(payload), {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: url.protocol === 'https:',
			maxAge: 300 // 5 minutes
		});
	}

	// Server-side redirect to /connections — the cookie carries the auth code.
	// This is more reliable than client-side JavaScript redirects.
	const resumeUrl = `/connections?oauth2_resume=1&state=${encodeURIComponent(state || '')}`;
	redirect(302, resumeUrl);
};

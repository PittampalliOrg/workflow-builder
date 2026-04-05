import type { PageServerLoad } from './$types';

/**
 * Server load function for the connections page.
 * Reads the OAuth2 callback cookie (set by the callback endpoint)
 * so the client can complete the token exchange.
 */
export const load: PageServerLoad = async ({ cookies, url }) => {
	const isResume = url.searchParams.get('oauth2_resume') === '1';
	let oauthCallback: { code?: string; state?: string; error?: string; errorDescription?: string } | null = null;

	if (isResume) {
		const raw = cookies.get('oauth2_callback');
		if (raw) {
			try {
				oauthCallback = JSON.parse(raw);
			} catch {
				// ignore malformed cookie
			}
			// Clear the cookie after reading
			cookies.delete('oauth2_callback', { path: '/' });
		}
	}

	return { oauthCallback };
};

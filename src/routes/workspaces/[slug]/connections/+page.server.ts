import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ cookies, url }) => {
	let oauthCallback: Record<string, string | null> | null = null;
	if (url.searchParams.get('oauth2_resume') === '1') {
		const raw = cookies.get('oauth2_callback');
		if (raw) {
			try {
				const parsed = JSON.parse(raw) as Record<string, string | null>;
				oauthCallback = parsed;
			} catch {
				oauthCallback = {
					error: 'invalid_callback',
					errorDescription: 'OAuth callback payload could not be parsed',
					state: url.searchParams.get('state')
				};
			}
			cookies.delete('oauth2_callback', { path: '/' });
		}
	}

	return { oauthCallback };
};

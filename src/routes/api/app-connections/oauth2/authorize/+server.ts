import { error, redirect, type RequestHandler } from '@sveltejs/kit';
import { getAppUrl } from '$lib/server/app-url';
import { getApplicationAdapters } from '$lib/server/application';

export const GET: RequestHandler = async ({ url, locals, request }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');

	const appUrl = await getAppUrl(url, request);
	const result = await getApplicationAdapters().workflowData.startAppConnectionOAuth2({
		pieceName: url.searchParams.get('pieceName'),
		redirectUrl: `${appUrl}/api/app-connections/oauth2/callback`
	});

	if (!result.ok) return error(result.status, result.message);
	throw redirect(302, result.authorizationUrl);
};

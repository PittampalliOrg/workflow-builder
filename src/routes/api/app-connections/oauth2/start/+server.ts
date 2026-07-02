import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getAppUrl } from '$lib/server/app-url';
import { getApplicationAdapters } from '$lib/server/application';

export const POST: RequestHandler = async ({ request, locals, url }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');

	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const appUrl = await getAppUrl(url, request);
	const redirectUrl =
		typeof body.redirectUrl === 'string' && body.redirectUrl.trim()
			? body.redirectUrl.trim()
			: `${appUrl}/api/app-connections/oauth2/callback`;

	const result = await getApplicationAdapters().workflowData.startAppConnectionOAuth2({
		pieceName: body.pieceName,
		pieceVersion: body.pieceVersion,
		clientId: body.clientId,
		redirectUrl,
		props: body.props
	});

	if (!result.ok) return error(result.status, result.message);
	return json(result);
};

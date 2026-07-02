import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getAppUrl } from '$lib/server/app-url';
import { getApplicationAdapters } from '$lib/server/application';
import { requireSessionProjectId } from '$lib/server/mcp-connections';

export const POST: RequestHandler = async ({ request, locals, url }) => {
	const projectId = requireSessionProjectId(locals);
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const appUrl = await getAppUrl(url, request);

	const result = await getApplicationAdapters().workflowData.completeAppConnectionOAuth2({
		projectId,
		connectionId: body.connectionId,
		pieceName: body.pieceName,
		code: body.code,
		codeVerifier: body.codeVerifier,
		redirectUrl: body.redirectUrl,
		defaultRedirectUrl: `${appUrl}/api/app-connections/oauth2/callback`
	});

	if (!result.ok) return error(result.status, result.message);
	return json({
		success: true,
		connection: result.connection
	});
};

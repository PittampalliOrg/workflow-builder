import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { validateInternalToken } from '$lib/server/internal-auth';

export const GET: RequestHandler = async ({ request, params }) => {
	if (!validateInternalToken(request)) return error(401, 'Unauthorized');

	const result = await getApplicationAdapters().workflowData.decryptAppConnectionValue({
		externalId: params.externalId
	});

	if (!result.ok) return error(result.status, result.message);
	return json({
		id: result.connection.id,
		externalId: result.connection.externalId,
		type: result.connection.type,
		pieceName: result.connection.pieceName,
		value: result.connection.value
	});
};

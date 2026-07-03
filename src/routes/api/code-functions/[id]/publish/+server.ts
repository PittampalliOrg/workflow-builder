import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getApplicationAdapters } from '$lib/server/application';
import { ApplicationCodeFunctionManagementError } from '$lib/server/application/code-function-management';

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) {
		throw error(401, 'Unauthorized');
	}
	if (!params.id) {
		throw error(400, 'id is required');
	}

	try {
		const published = await getApplicationAdapters().codeFunctionManagement.publish({
			id: params.id,
			userId: locals.session.userId,
		});
		return json(published);
	} catch (err) {
		if (err instanceof ApplicationCodeFunctionManagementError) {
			throw error(err.status, err.message);
		}
		throw err;
	}
};

import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getApplicationAdapters } from '$lib/server/application';
import { ApplicationCodeFunctionManagementError } from '$lib/server/application/code-function-management';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) {
		throw error(401, 'Unauthorized');
	}
	if (!params.id) {
		throw error(400, 'id is required');
	}

	try {
		const item = await getApplicationAdapters().codeFunctionManagement.get({
			id: params.id,
			userId: locals.session.userId,
		});
		return json(item);
	} catch (err) {
		handleCodeFunctionError(err);
	}
};

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) {
		throw error(401, 'Unauthorized');
	}
	if (!params.id) {
		throw error(400, 'id is required');
	}

	try {
		const updated = await getApplicationAdapters().codeFunctionManagement.update({
			id: params.id,
			userId: locals.session.userId,
			body: await request.json().catch(() => null),
		});
		return json(updated);
	} catch (err) {
		handleCodeFunctionError(err);
	}
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) {
		throw error(401, 'Unauthorized');
	}
	if (!params.id) {
		throw error(400, 'id is required');
	}

	try {
		return json(
			await getApplicationAdapters().codeFunctionManagement.delete({
				id: params.id,
				userId: locals.session.userId,
			}),
		);
	} catch (err) {
		handleCodeFunctionError(err);
	}
};

function handleCodeFunctionError(err: unknown): never {
	if (err instanceof ApplicationCodeFunctionManagementError) {
		throw error(err.status, err.message);
	}
	throw err;
}

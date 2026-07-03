import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getApplicationAdapters } from '$lib/server/application';
import { ApplicationCodeFunctionManagementError } from '$lib/server/application/code-function-management';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) {
		throw error(401, 'Unauthorized');
	}

	try {
		const functions = await getApplicationAdapters().codeFunctionManagement.list({
			userId: locals.session.userId,
		});
		return json({ functions, count: functions.length });
	} catch (err) {
		handleCodeFunctionError(err);
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) {
		throw error(401, 'Unauthorized');
	}

	try {
		const created = await getApplicationAdapters().codeFunctionManagement.create({
			userId: locals.session.userId,
			body: await request.json().catch(() => null),
		});
		return json(created, { status: 201 });
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

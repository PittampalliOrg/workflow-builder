import { error, json, type RequestHandler } from '@sveltejs/kit';
import {
	createCodeFunction,
	listCodeFunctions,
	type SaveCodeFunctionInput,
} from '$lib/server/code-functions';

function normalizeBody(body: unknown): SaveCodeFunctionInput {
	const data = (body || {}) as Partial<SaveCodeFunctionInput>;

	if (
		(data.language !== 'typescript' && data.language !== 'python') ||
		typeof data.source !== 'string' ||
		typeof data.name !== 'string'
	) {
		throw error(400, 'name, language, and source are required');
	}

	if (data.name.trim().length === 0 || data.source.trim().length === 0) {
		throw error(400, 'name and source must not be empty');
	}

	return {
		name: data.name,
		description: typeof data.description === 'string' ? data.description : null,
		language: data.language,
		entrypoint: typeof data.entrypoint === 'string' ? data.entrypoint : null,
		path: typeof data.path === 'string' ? data.path : null,
		source: data.source,
		supportingFiles:
			data.supportingFiles && typeof data.supportingFiles === 'object'
				? (data.supportingFiles as Record<string, string>)
				: null,
	};
}

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) {
		throw error(401, 'Unauthorized');
	}

	try {
		const functions = await listCodeFunctions(locals.session.userId);
		return json({ functions, count: functions.length });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw error(message === 'Database not configured' ? 503 : 500, message);
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) {
		throw error(401, 'Unauthorized');
	}

	const payload = normalizeBody(await request.json().catch(() => null));

	try {
		const created = await createCodeFunction(payload, locals.session.userId);
		return json(created, { status: 201 });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const status =
			message === 'Database not configured'
				? 503
				: message === 'Unauthorized'
					? 401
					: 502;
		throw error(status, message);
	}
};

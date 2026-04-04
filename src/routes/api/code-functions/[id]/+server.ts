import { error, json, type RequestHandler } from '@sveltejs/kit';
import {
	deleteCodeFunction,
	getCodeFunction,
	updateCodeFunction,
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

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) {
		throw error(401, 'Unauthorized');
	}
	if (!params.id) {
		throw error(400, 'id is required');
	}

	try {
		const item = await getCodeFunction(params.id, locals.session.userId);
		if (!item) {
			throw error(404, 'Code function not found');
		}
		return json(item);
	} catch (err) {
		if (err && typeof err === 'object' && 'status' in err) throw err;
		const message = err instanceof Error ? err.message : String(err);
		throw error(message === 'Database not configured' ? 503 : 500, message);
	}
};

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) {
		throw error(401, 'Unauthorized');
	}
	if (!params.id) {
		throw error(400, 'id is required');
	}

	const payload = normalizeBody(await request.json().catch(() => null));

	try {
		const updated = await updateCodeFunction(params.id, payload, locals.session.userId);
		if (!updated) {
			throw error(404, 'Code function not found');
		}
		return json(updated);
	} catch (err) {
		if (err && typeof err === 'object' && 'status' in err) throw err;
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

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) {
		throw error(401, 'Unauthorized');
	}
	if (!params.id) {
		throw error(400, 'id is required');
	}

	try {
		const deleted = await deleteCodeFunction(params.id, locals.session.userId);
		if (!deleted) {
			throw error(404, 'Code function not found');
		}
		return json({ success: true });
	} catch (err) {
		if (err && typeof err === 'object' && 'status' in err) throw err;
		const message = err instanceof Error ? err.message : String(err);
		throw error(message === 'Database not configured' ? 503 : 500, message);
	}
};

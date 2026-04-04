import { error, json, type RequestHandler } from '@sveltejs/kit';
import { publishCodeFunction } from '$lib/server/code-functions';

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) {
		throw error(401, 'Unauthorized');
	}
	if (!params.id) {
		throw error(400, 'id is required');
	}

	try {
		const published = await publishCodeFunction(params.id, locals.session.userId);
		if (!published) {
			throw error(404, 'Code function not found');
		}
		return json(published);
	} catch (err) {
		if (err && typeof err === 'object' && 'status' in err) throw err;
		const message = err instanceof Error ? err.message : String(err);
		throw error(message === 'Database not configured' ? 503 : 500, message);
	}
};

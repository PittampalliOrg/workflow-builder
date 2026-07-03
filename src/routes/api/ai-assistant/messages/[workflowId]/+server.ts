import { json, error, type RequestHandler } from '@sveltejs/kit';
import { getApplicationAdapters } from '$lib/server/application';

const MESSAGE_LIMIT = 100;

export const GET: RequestHandler = async ({ params, locals }) => {
	const userId = locals.session?.userId;
	if (!userId) return error(401, 'Unauthorized');

	const workflowId = params.workflowId;
	if (!workflowId) return error(400, 'Missing workflowId');

	let rows;
	try {
		rows = await getApplicationAdapters().workflowData.listAiAssistantMessages({
			workflowId,
			userId,
			limit: MESSAGE_LIMIT,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : '';
		if (/Database not configured/.test(message)) {
			return error(503, 'Database not configured');
		}
		throw err;
	}

	const messages = rows.map((row) => ({
		id: row.id,
		role: row.role,
		content: row.content,
		operations: row.operations ?? undefined,
		operationsApplied: false,
		createdAt: row.createdAt.toISOString(),
	}));

	return json({ messages });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	const userId = locals.session?.userId;
	if (!userId) return error(401, 'Unauthorized');

	const workflowId = params.workflowId;
	if (!workflowId) return error(400, 'Missing workflowId');

	try {
		await getApplicationAdapters().workflowData.deleteAiAssistantMessages({
			workflowId,
			userId,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : '';
		if (/Database not configured/.test(message)) {
			return error(503, 'Database not configured');
		}
		throw err;
	}

	return json({ ok: true });
};

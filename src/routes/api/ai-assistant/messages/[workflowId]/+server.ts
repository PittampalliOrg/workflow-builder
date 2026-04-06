import { json, error, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { workflowAiMessages } from '$lib/server/db/schema';
import { eq, and, asc } from 'drizzle-orm';

export const GET: RequestHandler = async ({ params, locals }) => {
	const userId = locals.session?.userId;
	if (!userId) return error(401, 'Unauthorized');

	const workflowId = params.workflowId;
	if (!workflowId) return error(400, 'Missing workflowId');

	const rows = await db
		.select()
		.from(workflowAiMessages)
		.where(
			and(
				eq(workflowAiMessages.workflowId, workflowId),
				eq(workflowAiMessages.userId, userId),
			),
		)
		.orderBy(asc(workflowAiMessages.createdAt))
		.limit(100);

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

	await db
		.delete(workflowAiMessages)
		.where(
			and(
				eq(workflowAiMessages.workflowId, workflowId),
				eq(workflowAiMessages.userId, userId),
			),
		);

	return json({ ok: true });
};

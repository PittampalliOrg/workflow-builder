import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { agents } from '$lib/server/db/schema';
import { desc } from 'drizzle-orm';

/**
 * GET /api/agents
 *
 * List all agents from the database.
 */
export const GET: RequestHandler = async () => {
	if (!db) return json([]);

	const result = await db
		.select({
			id: agents.id,
			name: agents.name,
			description: agents.description,
			agentType: agents.agentType,
			model: agents.model,
			tools: agents.tools,
			maxTurns: agents.maxTurns,
			isEnabled: agents.isEnabled,
			isDefault: agents.isDefault,
			createdAt: agents.createdAt
		})
		.from(agents)
		.orderBy(desc(agents.createdAt));

	return json(result);
};

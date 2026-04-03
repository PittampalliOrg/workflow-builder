import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { validateInternalToken } from '$lib/server/internal-auth';
import { db } from '$lib/server/db';
import { workflowExecutions, workflows } from '$lib/server/db/schema';
import { and, count, desc, eq } from 'drizzle-orm';

function parseIntegerParam(value: string | null): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * GET /api/internal/agent/workflows/executions
 *
 * Lists workflow executions with optional filters (workflowId, workflowName, status, limit, offset).
 * Security: Validated via X-Internal-Token header.
 */
export const GET: RequestHandler = async ({ request, url }) => {
	if (!validateInternalToken(request)) {
		return error(401, 'Unauthorized');
	}

	if (!db) {
		return error(503, 'Database not configured');
	}

	const workflowId = url.searchParams.get('workflowId') ?? undefined;
	const workflowName = url.searchParams.get('workflowName') ?? undefined;
	const status = url.searchParams.get('status') ?? undefined;
	const limit = Math.max(1, Math.min(parseIntegerParam(url.searchParams.get('limit')) ?? 100, 500));
	const offset = Math.max(0, parseIntegerParam(url.searchParams.get('offset')) ?? 0);

	const filters = [];

	if (workflowId?.trim()) {
		filters.push(eq(workflowExecutions.workflowId, workflowId.trim()));
	}

	if (workflowName?.trim()) {
		filters.push(eq(workflows.name, workflowName.trim()));
	}

	if (status?.trim()) {
		filters.push(eq(workflowExecutions.status, status.trim() as 'pending' | 'running' | 'success' | 'error' | 'cancelled'));
	}

	const whereClause = filters.length > 0 ? and(...filters) : undefined;

	const [rows, totalRows] = await Promise.all([
		db
			.select({
				id: workflowExecutions.id,
				workflowId: workflowExecutions.workflowId,
				status: workflowExecutions.status,
				phase: workflowExecutions.phase,
				progress: workflowExecutions.progress,
				error: workflowExecutions.error,
				startedAt: workflowExecutions.startedAt,
				completedAt: workflowExecutions.completedAt,
				workflow: {
					id: workflows.id,
					name: workflows.name,
					description: workflows.description
				}
			})
			.from(workflowExecutions)
			.innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
			.where(whereClause)
			.orderBy(desc(workflowExecutions.startedAt))
			.limit(limit)
			.offset(offset),
		db
			.select({ value: count() })
			.from(workflowExecutions)
			.innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
			.where(whereClause)
	]);

	return json({
		success: true,
		executions: rows,
		total: totalRows[0]?.value ?? 0
	});
};

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { workflowPlanArtifacts } from '$lib/server/db/schema';
import { desc, eq } from 'drizzle-orm';

/**
 * GET /api/workflows/executions/[executionId]/plan
 *
 * Fetches the plan content for an execution. The artifact table is the durable
 * source of truth; the dapr-agent-py state endpoint is retained as a legacy
 * fallback for older runs.
 */
export const GET: RequestHandler = async ({ params }) => {
	const { executionId } = params;

	const DAPR_HOST = process.env.DAPR_HOST || '127.0.0.1';
	const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || '3500';

	try {
		if (db) {
			const [artifact] = await db
				.select({
					planMarkdown: workflowPlanArtifacts.planMarkdown
				})
				.from(workflowPlanArtifacts)
				.where(eq(workflowPlanArtifacts.workflowExecutionId, executionId))
				.orderBy(desc(workflowPlanArtifacts.createdAt))
				.limit(1);

			if (artifact?.planMarkdown) {
				return json({ plan: artifact.planMarkdown });
			}
		}

		// Use Dapr service invocation to call dapr-agent-py's /plan endpoint
		// This works regardless of state store scoping since we invoke the service directly
		const invokeUrl = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/invoke/dapr-agent-py.openshell/method/plan/${encodeURIComponent(executionId)}`;
		const res = await fetch(invokeUrl, {
			headers: { 'Content-Type': 'application/json' }
		});

		if (!res.ok) {
			return json({ plan: null });
		}

		const data = await res.json();
		return json({ plan: data.plan ?? null });
	} catch {
		return json({ plan: null });
	}
};

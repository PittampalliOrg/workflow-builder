import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { eq, desc } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { workflows, workflowExecutions } from '$lib/server/db/schema';
import { validateInternalToken } from '$lib/server/internal-auth';
import { daprFetch, getOrchestratorUrl } from '$lib/server/dapr-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ExecuteBody = {
	workflowId?: string;
	workflowName?: string;
	triggerData?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSWWorkflow(spec: unknown): boolean {
	if (typeof spec !== 'object' || spec === null) return false;
	const w = spec as Record<string, unknown>;
	if (typeof w.document !== 'object' || w.document === null) return false;
	const doc = w.document as Record<string, unknown>;
	return (
		doc.dsl === '1.0.0' && typeof doc.namespace === 'string' && typeof doc.name === 'string'
	);
}

/**
 * Resolve a workflow by ID or by name (preferring public visibility).
 * Matches the Next.js `resolveInternalWorkflow` logic.
 */
async function resolveWorkflow(input: {
	workflowId?: string;
	workflowName?: string;
}): Promise<(typeof workflows.$inferSelect) | null> {
	const workflowId = input.workflowId?.trim();
	if (workflowId) {
		const [row] = await db!
			.select()
			.from(workflows)
			.where(eq(workflows.id, workflowId))
			.limit(1);
		return row ?? null;
	}

	const workflowName = input.workflowName?.trim();
	if (!workflowName) return null;

	const candidates = await db!
		.select()
		.from(workflows)
		.where(eq(workflows.name, workflowName))
		.orderBy(desc(workflows.updatedAt))
		.limit(20);

	if (candidates.length === 0) return null;
	return candidates.find((w) => w.visibility === 'public') ?? candidates[0] ?? null;
}

// ---------------------------------------------------------------------------
// POST /api/internal/agent/workflows/execute
//
// Called by dapr-swe (and other internal services) to register and start a
// workflow execution. Creates a DB execution record, then starts the workflow
// via the Dapr orchestrator.
//
// Auth: requires INTERNAL_API_TOKEN via X-Internal-Token header.
//
// Body:
//   { workflowId?: string, workflowName?: string, triggerData?: object }
//
// Returns:
//   { success: true, executionId, instanceId, workflowId, workflowName, status }
// ---------------------------------------------------------------------------

export const POST: RequestHandler = async ({ request }) => {
	if (!validateInternalToken(request)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	if (!db) {
		return json({ error: 'Database not configured' }, { status: 503 });
	}

	const body = (await request.json().catch(() => ({}))) as ExecuteBody;

	const workflow = await resolveWorkflow({
		workflowId: body.workflowId,
		workflowName: body.workflowName
	});

	if (!workflow) {
		return json({ error: 'Workflow not found' }, { status: 404 });
	}

	const triggerData = body.triggerData ?? {};

	try {
		// 1. Create execution record
		const [execution] = await db
			.insert(workflowExecutions)
			.values({
				workflowId: workflow.id,
				userId: workflow.userId,
				status: 'running',
				phase: 'running',
				progress: 0,
				input: triggerData,
				executionIrVersion: 'sw-1.0.0'
			})
			.returning();

		// 2. Start workflow via orchestrator
		const spec = (workflow as Record<string, unknown>).spec as Record<string, unknown> | null;
		const orchestratorUrl = workflow.daprOrchestratorUrl || getOrchestratorUrl();

		let instanceId: string | undefined;
		let startStatus = 'running';

		try {
			if (spec && isSWWorkflow(spec)) {
				// SW 1.0 workflow — use the sw-workflows endpoint
				const res = await daprFetch(`${orchestratorUrl}/api/v2/sw-workflows`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						workflow: spec,
						triggerData,
						dbExecutionId: execution.id
					})
				});

				if (!res.ok) {
					const errText = await res.text().catch(() => 'Unknown error');
					throw new Error(`Orchestrator error (${res.status}): ${errText}`);
				}

				const result = await res.json();
				instanceId = result.instanceId;
				startStatus = result.status ?? 'running';
			} else {
				// Legacy Dapr workflow — use the workflows endpoint
				const res = await daprFetch(`${orchestratorUrl}/api/v2/workflows`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						definition: {
							workflowId: workflow.id,
							name: workflow.name,
							nodes: workflow.nodes,
							edges: workflow.edges
						},
						triggerData,
						metadata: {},
						executionId: execution.id
					})
				});

				if (!res.ok) {
					const errText = await res.text().catch(() => 'Unknown error');
					throw new Error(`Orchestrator error (${res.status}): ${errText}`);
				}

				const result = await res.json();
				instanceId = result.instanceId;
				startStatus = result.status ?? 'running';
			}
		} catch (err) {
			// Mark execution as failed if orchestrator start fails
			await db
				.update(workflowExecutions)
				.set({
					status: 'error',
					phase: 'failed',
					error: err instanceof Error ? err.message : 'Failed to start workflow execution',
					completedAt: new Date()
				})
				.where(eq(workflowExecutions.id, execution.id));
			throw err;
		}

		// 3. Update execution with Dapr instance ID
		if (instanceId) {
			await db
				.update(workflowExecutions)
				.set({
					daprInstanceId: instanceId,
					phase: 'running',
					progress: 0
				})
				.where(eq(workflowExecutions.id, execution.id));
		}

		return json({
			success: true,
			executionId: execution.id,
			instanceId: instanceId ?? null,
			workflowId: workflow.id,
			workflowName: workflow.name,
			status: startStatus
		});
	} catch (err) {
		console.error('[internal/agent/workflows/execute] Failed:', err);
		return json(
			{
				error: err instanceof Error ? err.message : 'Failed to start workflow execution'
			},
			{ status: 500 }
		);
	}
};

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { assertExecutionReadModelColumns } from '$lib/server/db/execution-read-model-support';
import { workflows, workflowExecutions } from '$lib/server/db/schema';
import { validateInternalToken } from '$lib/server/internal-auth';
import { daprFetch, getOrchestratorUrl } from '$lib/server/dapr-client';
import {
	getSupportedWorkflowId,
	getTriggerLabel,
	resolveSupportedWorkflowTriggerFromEnvelope,
	findDuplicateSupportedWorkflowExecution,
	type ExternalEventEnvelope
} from '$lib/server/workflows/external-event-registry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function acceptedIgnored(reason: string) {
	return json({ status: 'ignored', reason }, { status: 202 });
}

function getSingleQueryParam(url: URL, key: string): string | undefined {
	const value = url.searchParams.get(key)?.trim();
	return value || undefined;
}

function normalizePayload(payload: unknown): unknown {
	if (typeof payload !== 'string') return payload;
	const trimmed = payload.trim();
	if (!trimmed) return payload;
	try {
		return JSON.parse(trimmed);
	} catch {
		return payload;
	}
}

function extractTraceHeaders(request: Request): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const h of ['traceparent', 'tracestate', 'baggage'] as const) {
		const v = request.headers.get(h);
		if (v) headers[h] = v;
	}
	return headers;
}

// ---------------------------------------------------------------------------
// POST /api/events/ingest?source=github|gitea&eventType=issues|issue_label
//
// Accepts external webhook events (from Argo Events or similar), resolves the
// target supported workflow, de-duplicates, and starts a SW 1.0 execution via
// the Dapr orchestrator.
//
// Auth: requires INTERNAL_API_TOKEN via X-Internal-Token header.
// ---------------------------------------------------------------------------

export const POST: RequestHandler = async ({ request, url }) => {
	// 1. Validate internal token
	if (!validateInternalToken(request)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	if (!db) {
		return json({ error: 'Database not configured' }, { status: 503 });
	}
	try {
		await assertExecutionReadModelColumns();
	} catch (schemaError) {
		console.error('[EventIngest] execution read-model schema check failed:', schemaError);
		return json(
			{
				error:
					schemaError instanceof Error
						? schemaError.message
						: 'Execution read-model migration is required'
			},
			{ status: 503 }
		);
	}

	// 2. Parse query params
	const source = getSingleQueryParam(url, 'source');
	const eventType = getSingleQueryParam(url, 'eventType');

	if ((source !== 'github' && source !== 'gitea') || typeof eventType !== 'string') {
		return json(
			{ error: 'Missing required source or eventType query parameter' },
			{ status: 400 }
		);
	}

	// 3. Parse body
	const body = (await request.json().catch(() => null)) as {
		eventId?: string;
		receivedAt?: string;
		payload?: unknown;
	} | null;

	if (!body || typeof body !== 'object') {
		return json({ error: 'Invalid JSON payload' }, { status: 400 });
	}

	// 4. Build envelope and resolve trigger
	const envelope: ExternalEventEnvelope = {
		source,
		eventType,
		eventId: typeof body.eventId === 'string' ? body.eventId : undefined,
		receivedAt: typeof body.receivedAt === 'string' ? body.receivedAt : undefined,
		payload: normalizePayload(body.payload)
	};

	const triggerLabel = getTriggerLabel(source);
	const resolved = resolveSupportedWorkflowTriggerFromEnvelope(envelope, triggerLabel);

	if (resolved.status === 'ignored') {
		return acceptedIgnored(resolved.reason);
	}

	// 5. Look up the supported workflow
	const supportedWorkflowId = getSupportedWorkflowId();
	if (!supportedWorkflowId) {
		return json({ error: 'SUPPORTED_WORKFLOW_ID not configured' }, { status: 500 });
	}

	const [workflow] = await db
		.select()
		.from(workflows)
		.where(eq(workflows.id, supportedWorkflowId))
		.limit(1);

	if (!workflow) {
		return json({ error: 'Workflow not found' }, { status: 404 });
	}

	// 6. Check for duplicate execution (same issue already running or PR created)
	const duplicate = await findDuplicateSupportedWorkflowExecution(
		workflow.id,
		resolved.input
	);
	if (duplicate) {
		return json({ status: 'ignored', ...duplicate }, { status: 202 });
	}

	// 7. Validate workflow has a SW 1.0 spec
	const spec = workflow.spec as Record<string, unknown> | null;
	if (!spec || !isSWWorkflow(spec)) {
		return json(
			{ error: 'Workflow does not have a valid CNCF Serverless Workflow 1.0 spec' },
			{ status: 400 }
		);
	}

	// 8. Create execution record
	let execution;
	try {
		[execution] = await db
			.insert(workflowExecutions)
			.values({
				workflowId: workflow.id,
				userId: workflow.userId,
				status: 'running',
				phase: 'running',
				progress: 0,
				input: resolved.input,
				executionIrVersion: 'sw-1.0.0'
			})
			.returning({ id: workflowExecutions.id });
	} catch (dbErr) {
		console.error('[EventIngest] DB insert failed:', dbErr);
		return json({ error: 'Failed to create execution record' }, { status: 500 });
	}

	// 9. Start workflow via orchestrator
	const orchestratorUrl = getOrchestratorUrl();

	try {
		const res = await daprFetch(`${orchestratorUrl}/api/v2/sw-workflows`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...extractTraceHeaders(request)
			},
			body: JSON.stringify({
				workflow: spec,
				workflowId: workflow.id,
				triggerData: resolved.input,
				dbExecutionId: execution.id
			})
		});

		if (!res.ok) {
			const errText = await res.text().catch(() => 'Unknown error');
			console.error(`[EventIngest] Orchestrator ${res.status}: ${errText}`);
			await db
				.update(workflowExecutions)
				.set({
					status: 'error',
					error: `SW workflow failed: ${res.status} ${errText}`.slice(0, 500),
					completedAt: new Date()
				})
				.where(eq(workflowExecutions.id, execution.id));

			return json(
				{ error: `SW workflow failed: ${res.status} ${errText}` },
				{ status: 502 }
			);
		}

		const result = await res.json();

		// 10. Update execution with Dapr instance ID
		await db
			.update(workflowExecutions)
			.set({
				daprInstanceId: result.instanceId,
				phase: 'running',
				progress: 0,
				workflowSessionId: execution.id
			})
			.where(eq(workflowExecutions.id, execution.id));

		console.log(
			`[EventIngest] SW 1.0 workflow started: ${result.instanceId} (execution ${execution.id})`
		);

		return json(
			{
				status: 'accepted',
				source,
				eventType,
				workflowId: workflow.id,
				executionId: execution.id,
				instanceId: result.instanceId,
				eventId: envelope.eventId
			},
			{ status: 202 }
		);
	} catch (err) {
		console.error('[EventIngest] Orchestrator request failed:', err);
		await db
			.update(workflowExecutions)
			.set({
				status: 'error',
				error: err instanceof Error ? err.message : 'Failed to start SW workflow',
				completedAt: new Date()
			})
			.where(eq(workflowExecutions.id, execution.id));

		return json(
			{
				error: err instanceof Error ? err.message : 'Failed to start workflow execution'
			},
			{ status: 500 }
		);
	}
};

function isSWWorkflow(spec: unknown): boolean {
	if (typeof spec !== 'object' || spec === null) return false;
	const w = spec as Record<string, unknown>;
	if (typeof w.document !== 'object' || w.document === null) return false;
	const doc = w.document as Record<string, unknown>;
	return doc.dsl === '1.0.0' && typeof doc.namespace === 'string' && typeof doc.name === 'string';
}

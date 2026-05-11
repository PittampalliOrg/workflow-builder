import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';

function trackingUri(): string | null {
	const value = (env.MLFLOW_TRACKING_URI ?? '').trim().replace(/\/+$/, '');
	return value || null;
}

function publicMlflowUrl(): string | null {
	const value = (publicEnv.PUBLIC_MLFLOW_URL ?? env.PUBLIC_MLFLOW_URL ?? '')
		.trim()
		.replace(/\/+$/, '');
	return value || null;
}

function traceExperimentName(): string {
	return (env.MLFLOW_TRACE_EXPERIMENT_NAME ?? '').trim() || 'workflow-builder';
}

function configuredTraceExperimentId(): string | null {
	const value = (env.MLFLOW_TRACE_EXPERIMENT_ID ?? publicEnv.PUBLIC_MLFLOW_TRACE_EXPERIMENT_ID ?? '')
		.trim();
	return value || null;
}

function mlflowTraceRequestId(traceId: string): string {
	const value = traceId.trim();
	return value.startsWith('tr-') ? value : `tr-${value}`;
}

async function mlflowRequest<T>(path: string): Promise<T> {
	const base = trackingUri();
	if (!base) throw new Error('MLFLOW_TRACKING_URI is not configured');
	const rawTimeoutMs = Number(env.MLFLOW_REQUEST_TIMEOUT_MS ?? 3000);
	const timeoutMs = Number.isFinite(rawTimeoutMs) ? Math.max(500, rawTimeoutMs) : 3000;
	const res = await fetch(`${base}${path}`, {
		method: 'GET',
		signal: AbortSignal.timeout(timeoutMs),
		headers: { Accept: 'application/json' }
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`MLflow ${path} returned ${res.status}: ${text.slice(0, 500)}`);
	}
	return (await res.json()) as T;
}

let traceExperimentIdCache: string | null | undefined;

export function publicMlflowTraceSearchUrl(
	experimentId: string | null | undefined,
	filter?: { traceId?: string | null; sessionId?: string | null }
): string | null {
	const base = publicMlflowUrl();
	if (!base || !experimentId) return null;
	const traceId = filter?.traceId?.trim();
	const sessionId = filter?.sessionId?.trim();
	const encodedExperimentId = encodeURIComponent(experimentId);
	if (traceId) {
		const query = new URLSearchParams({ selectedEvaluationId: mlflowTraceRequestId(traceId) });
		return `${base}/#/experiments/${encodedExperimentId}/traces?${query.toString()}`;
	}
	if (sessionId) {
		return `${base}/#/experiments/${encodedExperimentId}/chat-sessions/${encodeURIComponent(sessionId)}`;
	}
	return `${base}/#/experiments/${encodedExperimentId}/traces`;
}

export async function getMlflowTraceExperimentId(): Promise<string | null> {
	const configured = configuredTraceExperimentId();
	if (configured) return configured;
	if (traceExperimentIdCache !== undefined) return traceExperimentIdCache;

	const base = publicMlflowUrl();
	const tracking = trackingUri();
	if (!base || !tracking) {
		traceExperimentIdCache = null;
		return null;
	}

	const query = new URLSearchParams({ experiment_name: traceExperimentName() });
	try {
		const payload = await mlflowRequest<{ experiment?: { experiment_id?: string } }>(
			`/api/2.0/mlflow/experiments/get-by-name?${query.toString()}`
		);
		traceExperimentIdCache = payload.experiment?.experiment_id ?? null;
	} catch (err) {
		console.warn('[mlflow] trace experiment lookup failed:', err instanceof Error ? err.message : err);
		traceExperimentIdCache = null;
	}
	return traceExperimentIdCache;
}

export async function publicMlflowTraceRedirectUrl(
	filter: { traceId?: string | null; sessionId?: string | null } = {}
): Promise<string | null> {
	const experimentId = await getMlflowTraceExperimentId();
	return publicMlflowTraceSearchUrl(experimentId, filter);
}

/**
 * Resolve a workflow execution id to an MLflow trace_id. Reads
 * `workflow_executions.primary_trace_id` (the OTEL trace_id captured by the
 * orchestrator at workflow start) and constructs the MLflow trace_id as
 * `tr-<otel_trace_id>` — that's the exact mapping the MLflow SDK uses
 * internally, so no MLflow round-trip needed.
 *
 * Returns the MLflow OSS UI URL or null if the execution row is missing /
 * MLflow is unconfigured.
 */
export async function resolveMlflowTraceUrlForExecution(
	executionId: string
): Promise<string | null> {
	const experimentId = await getMlflowTraceExperimentId();
	if (!experimentId) return null;

	const { db } = await import('$lib/server/db');
	const { workflowExecutions } = await import('$lib/server/db/schema');
	const { eq } = await import('drizzle-orm');

	const row = await db
		.select({ primaryTraceId: workflowExecutions.primaryTraceId })
		.from(workflowExecutions)
		.where(eq(workflowExecutions.id, executionId))
		.limit(1);
	const traceId = row[0]?.primaryTraceId?.trim();
	if (!traceId) return null;
	return publicMlflowTraceSearchUrl(experimentId, { traceId });
}

/**
 * Resolve an executionId to a tr-<hex> MLflow trace_id by reading
 * `workflow_executions.primary_trace_id`. Returns null when the
 * execution row is missing or the trace_id hasn't been captured yet.
 *
 * Used by Phase 3b's feedback widget to translate UI input
 * (executionId) into the trace_id MLflow needs.
 */
export async function resolveMlflowTraceIdForExecution(
	executionId: string
): Promise<string | null> {
	const { db } = await import('$lib/server/db');
	const { workflowExecutions } = await import('$lib/server/db/schema');
	const { eq } = await import('drizzle-orm');

	const row = await db
		.select({ primaryTraceId: workflowExecutions.primaryTraceId })
		.from(workflowExecutions)
		.where(eq(workflowExecutions.id, executionId))
		.limit(1);
	const raw = row[0]?.primaryTraceId?.trim();
	if (!raw) return null;
	return raw.startsWith('tr-') ? raw : `tr-${raw}`;
}

/**
 * POST a feedback assessment to the orchestrator's
 * /api/v2/observability/feedback endpoint, which wraps
 * `mlflow.log_feedback(...)`. Phase 3b of the MLflow 3.12 enhancement
 * plan (research-the-most-popular-stateful-hinton.md).
 *
 * Caller is responsible for resolving executionId → trace_id first.
 */
export async function logTraceFeedback(args: {
	traceId: string;
	name?: string;
	value?: number | string | boolean | null;
	rationale?: string | null;
	sourceType?: 'HUMAN' | 'AI_JUDGE' | 'LLM_JUDGE' | 'CODE';
	sourceId?: string;
	metadata?: Record<string, unknown> | null;
}): Promise<{ assessmentId: string | null } | null> {
	const { getOrchestratorUrl, daprFetch } = await import('$lib/server/dapr-client');
	const orchestratorUrl = getOrchestratorUrl();

	const body = {
		trace_id: args.traceId.startsWith('tr-') ? args.traceId : `tr-${args.traceId}`,
		name: args.name ?? 'user_rating',
		value: args.value ?? null,
		rationale: args.rationale ?? null,
		source_type: args.sourceType ?? 'HUMAN',
		source_id: args.sourceId ?? 'anonymous',
		metadata: args.metadata ?? null
	};

	try {
		const res = await daprFetch(`${orchestratorUrl}/api/v2/observability/feedback`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!res.ok) {
			const errText = await res.text().catch(() => '');
			console.warn(
				'[mlflow] logTraceFeedback orchestrator returned',
				res.status,
				errText.slice(0, 300)
			);
			return null;
		}
		const payload = (await res.json()) as { assessment_id?: string | null };
		return { assessmentId: payload.assessment_id ?? null };
	} catch (err) {
		console.warn('[mlflow] logTraceFeedback failed:', err instanceof Error ? err.message : err);
		return null;
	}
}
